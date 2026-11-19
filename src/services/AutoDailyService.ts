import {
  buildCardMessages,
  deliverCardMessage,
} from "../utils/cardNotification";
import { ExtendedClient } from "../structures/Client";
import { formatSkGameRole, getGamePlayerBinding } from "../utils/skportApi";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../utils/accountUtils";
import { accountId, patchAccount } from "../utils/accountData";
import {
  DailyGameScope,
  gameIdsForScope,
  normalizeBindingRoles,
  toAttendanceRole,
} from "../utils/bindingRoles";
import { createTranslator } from "../utils/i18n";
import { AttachmentBuilder } from "discord.js";
import { Logger } from "../utils/Logger";
import { processRoleAttendance } from "../utils/attendanceUtils";
import {
  buildDailyAttendanceCard,
  DailyCardPayload,
} from "../utils/dailyCanvasUtils";
import {
  AttendanceKind,
  AutoDailyState,
  classifyAttendance,
  isTokenExpiredError,
  nextAutoDailyState,
  nextHourStart,
  planAutoDaily,
  RunSummary,
  taipeiDate,
  taipeiHour,
} from "./autoDailyPlan";

interface AutoDailyConfig {
  time: number; // 0-23
  auto_balance: boolean;
  notify: boolean;
  notify_method: "dm" | "channel";
  channelId?: string;
  mention?: boolean;
  game_scope?: DailyGameScope;
}

interface AutoDailyResult {
  gameId?: number;
  roleName: string;
  roleMeta: string;
  rewardName: string;
  rewardIcon: string;
  firstRewardName?: string;
  firstRewardIcon?: string;
  totalDays: number;
  calendarTotalDays: number;
  todayClaimedNow: boolean;
  checkedDaysThisMonth?: number;
  missedDaysThisMonth?: number;
  yesterdayReward?: {
    name: string;
    icon?: string;
    resourceId?: string;
    done?: boolean;
  };
  todayReward?: {
    name: string;
    icon?: string;
    resourceId?: string;
    done?: boolean;
  };
  nextRewards?: {
    name: string;
    icon?: string;
    resourceId?: string;
    done?: boolean;
  }[];
  status: string;
  kind?: AttendanceKind;
  isError?: boolean;
  accountIdx?: number;
}

export class AutoDailyService {
  private client: ExtendedClient;
  private interval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private logger: Logger;
  private cardCache = new Map<string, { buffer: Buffer; expireAt: number }>();
  private readonly CARD_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly CARD_CACHE_MAX_SIZE = 50;

  private parseHourCandidates(value: unknown): number[] {
    const toHour = (raw: unknown): number | null => {
      const num = Number(raw);
      if (!Number.isFinite(num)) return null;
      const n = Math.floor(num);
      if (n === 24) return 0;
      if (n >= 0 && n <= 23) return n;
      if (n >= 1 && n <= 24) return n % 24;
      return null;
    };

    if (Array.isArray(value)) {
      const arr = value
        .map((x) => toHour(x))
        .filter((x): x is number => x !== null);
      return arr;
    }

    if (typeof value === "string") {
      const parts = value
        .split(/[\s,，、;；|/]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length > 1) {
        return parts
          .map((x) => toHour(x))
          .filter((x): x is number => x !== null);
      }
    }

    const one = toHour(value);
    return one === null ? [] : [one];
  }

  private normalizeHour(value: unknown, fallback: number): number {
    const parsed = this.parseHourCandidates(value);
    return parsed.length > 0 ? parsed[0] : fallback;
  }

  private normalizeGameScope(
    value: unknown,
    fallback: DailyGameScope,
  ): DailyGameScope {
    if (value === "endfield" || value === "arknights" || value === "both") {
      return value;
    }
    return fallback;
  }

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("AutoDaily");
  }

  private makeCardCacheKey(payload: DailyCardPayload): string {
    return [
      payload.gameId || 0,
      payload.roleName,
      payload.totalDays,
      payload.todayClaimedNow ? "1" : "0",
      payload.todayReward.name,
      payload.todayReward.done ? "1" : "0",
    ].join("|");
  }

  private pruneCardCache(now: number) {
    if (this.cardCache.size < this.CARD_CACHE_MAX_SIZE) return;

    for (const [key, value] of this.cardCache.entries()) {
      if (value.expireAt <= now) {
        this.cardCache.delete(key);
      }
    }

    while (this.cardCache.size > this.CARD_CACHE_MAX_SIZE) {
      const oldestKey = this.cardCache.keys().next().value;
      if (!oldestKey) break;
      this.cardCache.delete(oldestKey);
    }
  }

  private async renderCardWithCache(
    payload: DailyCardPayload,
  ): Promise<Buffer> {
    const now = Date.now();
    const key = this.makeCardCacheKey(payload);
    const cached = this.cardCache.get(key);
    if (cached && cached.expireAt > now) {
      return cached.buffer;
    }

    const buffer = await buildDailyAttendanceCard(payload);
    this.cardCache.set(key, {
      buffer,
      expireAt: now + this.CARD_CACHE_TTL_MS,
    });
    this.pruneCardCache(now);
    return buffer;
  }

  public async start() {
    if (this.interval) return;

    // Immediately run check for current hour to catch missed tasks during restart
    await this.runHourlyCheck();

    this.scheduleNextRun();
    this.logger.success("Service started.");
  }

  public stop() {
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
    }
    this.logger.info("Service stopped.");
  }

  private scheduleNextRun() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const msUtilNextHour = ((60 - minutes) * 60 - seconds) * 1000;

    // Add a small buffer to ensure we are definitely in the next hour
    this.interval = setTimeout(() => {
      this.runHourlyCheck();
      this.scheduleNextRun(); // Reschedule recursively
    }, msUtilNextHour + 1000);
  }

  public async manualRunRange(startHour: number, endHour: number) {
    this.logger.warn(
      `Manually running range: ${startHour}:00 to ${endHour}:00 (Asia/Taipei)`,
    );
    for (let h = startHour; h <= endHour; h++) {
      await this.runHourlyCheck(h);
    }
  }

  private async runHourlyCheck(targetHour?: number) {
    if (this.isRunning && targetHour === undefined) return;
    if (targetHour === undefined) this.isRunning = true;

    try {
      const nowMs = Date.now();
      const today = taipeiDate(nowMs);
      const currentHour =
        targetHour !== undefined ? targetHour : taipeiHour(nowMs);
      this.logger.info(
        `Running checks for hour ${currentHour}:00 (Asia/Taipei)`,
      );

      // Migrate to prefixed keys
      const dailyUsers =
        await this.client.db.findByPrefix<AutoDailyConfig>("autoDaily.");
      const states = new Map<string, AutoDailyState>();
      for (const { id, value } of await this.client.db.findByPrefix<AutoDailyState>(
        "autoDailyState.",
      )) {
        if (value && typeof value === "object")
          states.set(id.replace("autoDailyState.", ""), value);
      }

      const eligibleUsers = [];
      for (const { id, value: config } of dailyUsers) {
        if (!config || typeof config !== "object") continue;

        const normalizedTime = this.normalizeHour((config as any).time, 13);
        const normalizedNotifyMethod =
          (config as any).notify_method === "channel" ? "channel" : "dm";
        const normalizedMention = (config as any).mention !== false;
        const normalizedGameScope = this.normalizeGameScope(
          (config as any).game_scope,
          "both",
        );

        const hasChanged =
          (config as any).time !== normalizedTime ||
          (config as any).notify_method !== normalizedNotifyMethod ||
          (config as any).mention !== normalizedMention ||
          (config as any).game_scope !== normalizedGameScope;

        if (hasChanged) {
          (config as any).time = normalizedTime;
          (config as any).notify_method = normalizedNotifyMethod;
          (config as any).mention = normalizedMention;
          (config as any).game_scope = normalizedGameScope;
          await this.client.db.set(id, config);
        }

        const userId = id.replace("autoDaily.", "");
        const state = states.get(userId);
        if (targetHour !== undefined) {
          // Manual range: the users configured for that hour, unless already done today.
          if ((config as any).time !== currentHour) continue;
          if (state?.date === today && state.status === "done") continue;
        } else if (planAutoDaily(nowMs, config as any, state) !== "run") {
          continue;
        }

        eligibleUsers.push({ userId, config });
      }

      this.logger.info(`Found ${eligibleUsers.length} users for this hour.`);

      for (const { userId, config } of eligibleUsers) {
        await this.processUser(userId, config, currentHour);
      }

      // 簽到任務完成後手動觸發垃圾回收 (GC)
      if (typeof global.gc === "function") {
        this.logger.info(
          "Triggering manual garbage collection after hourly check...",
        );
        global.gc();
      }
    } catch (error) {
      this.logger.error(
        "Error in hourly check: " +
          (error instanceof Error ? error.message : error),
      );
    } finally {
      this.isRunning = false;
    }
  }

  private makeErrorResult(roleName: string, status: string) {
    return {
      roleName,
      roleMeta: "",
      rewardName: "",
      rewardIcon: "",
      totalDays: 0,
      calendarTotalDays: 0,
      todayClaimedNow: false,
      status,
      isError: true as const,
    };
  }

  /**
   * Tells the user once that this account must be logged in again. Ignores `notify`.
   * Returns true when the user has been dealt with (sent, or DMs are closed): the flag is
   * set so we do not try again. Other failures leave the flag unset and retry next time.
   */
  private async notifyTokenExpired(
    userId: string,
    account: any,
    tr: any,
  ): Promise<boolean> {
    let delivered = true;
    try {
      const user = await this.client.users.fetch(userId);
      await user.send({
        content: tr("autoDaily_TokenExpiredDM", {
          name: account.info?.nickname || account.info?.id || "?",
        }),
        allowedMentions: { parse: [] },
      });
    } catch (error: any) {
      if (error?.code !== 50007) {
        this.logger.error(
          `Failed to send token-expired DM to ${userId}: ${error?.message || error}`,
        );
        return false;
      }
      delivered = false; // DMs closed: swallow, but do not ask again
    }
    account.tokenExpiredNotified = true;
    patchAccount(this.client.db, userId, accountId(account), {
      tokenExpiredNotified: true,
    });
    return delivered;
  }

  public async processUser(
    userId: string,
    config: AutoDailyConfig,
    hour?: number,
  ) {
    const db = this.client.db;
    try {
      const nowMs = Date.now();
      const today = taipeiDate(nowMs);
      const hr = hour ?? taipeiHour(nowMs);
      // One run per user per hour, even if two primaries overlap (graceful recluster can
      // briefly run two cluster-0s). Whether today is finished is tracked separately in
      // autoDailyState, so a failed hour does not use up the day.
      if (!db.claimSlot(`${userId}.autoDailyHour`, `${today}T${hr}`)) {
        this.logger.info(
          `Skipping user ${userId}: already processed for ${today} hour ${hr}.`,
        );
        return;
      }

      const stateKey = `autoDailyState.${userId}`;
      let prev = await db.get<AutoDailyState>(stateKey);
      if (!prev || prev.date !== today) {
        prev = null;
        // Rows from before autoDailyState existed: the old code marked the day here.
        if ((await db.get(`${userId}.lastAutoDaily`)) === today) {
          await db.set(stateKey, { date: today, status: "done", attempts: 0 });
          return;
        }
      } else if (prev.status === "done") {
        return;
      }

      // Write the attempt first: a crash mid-run still counts, so a bad user cannot loop.
      const attempts = (prev?.attempts ?? 0) + 1;
      await db.set(stateKey, {
        date: today,
        status: "retry",
        attempts,
        nextAttemptAt: nextHourStart(nowMs),
        ...(prev?.lastError ? { lastError: prev.lastError } : {}),
      } satisfies AutoDailyState);

      const accounts = await getAccounts(db, userId);
      if (!accounts || accounts.length === 0) {
        await db.set(stateKey, { date: today, status: "done", attempts });
        return;
      }

      const summary: RunSummary = {
        signed: 0,
        already: 0,
        error: 0,
        tokenExpiredPending: 0,
        tokenExpiredConfirmed: 0,
      };
      let lastError: string | undefined;
      this.logger.info(`Starting auto-daily processing for user ${userId}`);
      const results: AutoDailyResult[] = [];
      const confirmedExpired: any[] = [];

      const processedRoles = new Set<string>();

      const userLang = (await db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      const markExpired = (account: any, wasInvalid: boolean) => {
        // Seen dead on entry and still dead: confirmed. A first sighting could be an SKPort
        // outage (all recovery steps fail on network errors too), so confirm next hour.
        if (wasInvalid) {
          summary.tokenExpiredConfirmed++;
          if (!confirmedExpired.includes(account)) confirmedExpired.push(account);
        } else {
          summary.tokenExpiredPending++;
        }
      };

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const wasInvalid = !!account.invalid;

        try {
          // Always attempt account validation/recovery, even if previously marked invalid.
          // ensureAccountBinding will try all 3 refresh steps and clear the invalid flag if successful.
          await ensureAccountBinding(account, userId, db, tr.lang);

          const expiredResult = () => {
            this.logger.warn(
              `Unrecoverable account for user ${userId}: ${account.info?.nickname} (${account.info?.id})`,
            );
            results.push({
              ...this.makeErrorResult(
                account.info?.nickname || "Unknown",
                tr("TokenExpired"),
              ),
              kind: "token_expired",
              accountIdx: i,
            });
            markExpired(account, wasInvalid);
          };

          if (account.invalid) {
            // Still invalid after recovery attempt — token is truly expired
            expiredResult();
            continue;
          }

          const gameScope = this.normalizeGameScope(config.game_scope, "both");

          let liveBindings: any = null;
          let roles = normalizeBindingRoles(
            account.roles,
            gameIdsForScope(gameScope),
          );
          try {
            liveBindings = await withAutoRefresh(
              this.client,
              userId,
              account,
              (c: string, s: string, options: any) =>
                getGamePlayerBinding(
                  account.cookie,
                  tr.lang,
                  c,
                  s,
                  options,
                  account.info?.id,
                ),
              tr.lang,
            );
            const liveRoles = normalizeBindingRoles(
              liveBindings,
              gameIdsForScope(gameScope),
            );
            if (liveRoles.length > 0) {
              roles = liveRoles;
            }
          } catch {
            // Keep using locally cached bindings when refresh fails.
          }

          // Re-check invalid flag: the getGamePlayerBinding onStale may have
          // exhausted all refresh steps and marked the account invalid.
          if (account.invalid) {
            expiredResult();
            continue;
          }

          // Fallback: if the configured scope filtered out all roles (e.g. user has
          // only Endfield chars but scope was saved as "arknights"), retry with "both".
          if (roles.length === 0 && gameScope !== "both") {
            const bothIds = gameIdsForScope("both");
            const fallbackLive = normalizeBindingRoles(liveBindings, bothIds);
            roles =
              fallbackLive.length > 0
                ? fallbackLive
                : normalizeBindingRoles(account.roles, bothIds);
          }

          if (roles.length === 0) {
            // No game role for any game in scope (e.g. an Endfield binding without a role:
            // 176 such bindings in production). Nothing can be signed, so this is neither an
            // error nor worth a retry or a DM.
            this.logger.debug(
              `Skipping account ${account.info?.nickname} (${account.info?.id}) of user ${userId}: no game role in scope ${gameScope}.`,
            );
            continue;
          }

          for (const normalized of roles) {
            const role = toAttendanceRole(normalized);
            const gameId = normalized.gameId;
            const gameRoleStr = formatSkGameRole(
              gameId,
              role.roleId,
              role.serverId,
            );

            if (processedRoles.has(gameRoleStr)) continue;
            processedRoles.add(gameRoleStr);

            try {
              const res: any = await withAutoRefresh(
                this.client,
                userId,
                account,
                (c: string, s: string, opt: any) =>
                  processRoleAttendance(
                    role,
                    gameId,
                    account.cookie,
                    tr.lang,
                    c,
                    s,
                    true,
                    tr,
                    opt,
                  ),
                tr.lang,
              );

              if (res) {
                const kind = classifyAttendance(res);
                const isArknights = Number(gameId) === 1;
                const roleName = `${res.nickname ?? role.nickname}`;
                const roleMeta = isArknights
                  ? `${role.serverName || "-"}`
                  : `Lv.${res.level ?? role.level} - ${role.serverName || "-"}`;

                let status: string;
                if (kind === "signed") {
                  summary.signed++;
                  status = tr("daily_Success");
                } else if (kind === "already") {
                  summary.already++;
                  status = tr("daily_StatusAlready");
                } else if (kind === "token_expired") {
                  markExpired(account, wasInvalid);
                  status = tr("TokenExpired");
                } else {
                  summary.error++;
                  // The real reason, never "already signed".
                  status = String(res.message || tr("Error"));
                  lastError = status.slice(0, 200);
                }

                // Support multi-line rewards from Python logic
                const displayedReward = res.rewardName || tr("None");

                results.push({
                  gameId,
                  roleName,
                  roleMeta,
                  rewardName: displayedReward,
                  rewardIcon: res.rewardIcon,
                  firstRewardName: res.firstRewardName,
                  totalDays: res.totalDays,
                  calendarTotalDays: res.calendarTotalDays || 0,
                  todayClaimedNow: !!res.signedNow,
                  checkedDaysThisMonth: res.checkedDaysThisMonth,
                  missedDaysThisMonth: res.missedDaysThisMonth,
                  yesterdayReward: res.yesterdayReward,
                  todayReward: res.todayReward,
                  nextRewards: res.nextRewards,
                  status,
                  kind,
                  isError: kind === "error" || kind === "token_expired",
                  accountIdx: i,
                });

                this.logger.info(
                  `User ${userId} - Role ${res.nickname} (${res.uid}): ${kind.toUpperCase()}` +
                    (res.signedNow ? ` (Reward: ${displayedReward})` : ""),
                );
              }
            } catch (roleError) {
              this.logger.error(
                `Error processing role ${gameRoleStr} for user ${userId}: ${roleError}`,
              );
              const dead = isTokenExpiredError(roleError);
              results.push({
                ...this.makeErrorResult(
                  role.nickname || "Unknown",
                  dead ? tr("TokenExpired") : tr("Error"),
                ),
                kind: dead ? "token_expired" : "error",
                accountIdx: i,
              });
              if (dead) {
                markExpired(account, wasInvalid);
              } else {
                summary.error++;
                lastError =
                  roleError instanceof Error
                    ? roleError.message.slice(0, 200)
                    : String(roleError).slice(0, 200);
              }
            }
          }
        } catch (accError) {
          this.logger.error(
            `Error processing account ${account.info?.id} for user ${userId}: ${accError}`,
          );
          results.push({
            ...this.makeErrorResult(
              account.info?.nickname || "Unknown",
              tr("Error"),
            ),
            kind: "error",
            accountIdx: i,
          });
          summary.error++;
          lastError =
            accError instanceof Error
              ? accError.message.slice(0, 200)
              : String(accError).slice(0, 200);
        }
      }

      this.logger.info(
        `Finished auto-daily for user ${userId} (attempt ${attempts}). Result: ${summary.signed} success, ${summary.already} already signed, ${summary.error} failed, ${summary.tokenExpiredPending + summary.tokenExpiredConfirmed} token expired.`,
      );

      // Today is marked done only after every role signed or was already signed.
      const finalState = nextAutoDailyState(
        today,
        Date.now(),
        attempts,
        summary,
        lastError,
      );
      await db.set(stateKey, finalState);
      if (finalState.status === "done") {
        // Kept for rollback: the previous version reads this key.
        await db.set(`${userId}.lastAutoDaily`, today);
      }
      const terminal = finalState.status !== "retry";

      // Dead tokens: tell the user once per expiry, whatever `notify` says.
      const toldAboutExpiry = new Set<any>();
      for (const account of confirmedExpired) {
        if (account.tokenExpiredNotified) {
          toldAboutExpiry.add(account);
          continue;
        }
        if (await this.notifyTokenExpired(userId, account, tr))
          toldAboutExpiry.add(account);
      }

      if (config.notify && results.length > 0) {
        // Group non-error results by account, preserving order. Retries stay quiet about
        // roles already reported and about failures that will be retried.
        const accountGroups = new Map<
          number,
          { res: (typeof results)[0]; idx: number }[]
        >();
        const errorLines: string[] = [];

        for (const [idx, res] of results.entries()) {
          const accountIdx = res.accountIdx ?? 0;
          if (!res.isError) {
            if (attempts > 1 && res.kind === "already") continue;
            if (!accountGroups.has(accountIdx))
              accountGroups.set(accountIdx, []);
            accountGroups.get(accountIdx)!.push({ res, idx });
          } else {
            if (attempts > 1 && !terminal) continue;
            if (
              res.kind === "token_expired" &&
              toldAboutExpiry.has(accounts[accountIdx])
            )
              continue;
            errorLines.push(`- ${res.roleName}: ${res.status}`);
          }
        }

        // Build all card files grouped by account
        type CardGroup = {
          accountIdx: number;
          files: AttachmentBuilder[];
          fileNames: string[];
        };
        const cardGroups: CardGroup[] = [];
        let fileCounter = 0;

        for (const [accountIdx, entries] of accountGroups.entries()) {
          const groupFiles: AttachmentBuilder[] = [];
          const groupFileNames: string[] = [];

          for (const { res } of entries) {
            const cardPayload: DailyCardPayload = {
              roleName: res.roleName,
              roleMeta: res.roleMeta || "",
              gameId: Number(res.gameId || 3),
              totalDays: Number(res.totalDays || 0),
              calendarTotalDays: Number(res.calendarTotalDays || 0),
              todayClaimedNow: !!res.todayClaimedNow,
              checkedDaysThisMonth: Number(res.checkedDaysThisMonth || 0),
              missedDaysThisMonth: Number(res.missedDaysThisMonth || 0),
              yesterdayReward: {
                name: res.yesterdayReward?.name || tr("None") || "None",
                icon: res.yesterdayReward?.icon || "",
                resourceId: res.yesterdayReward?.resourceId || "",
                done: !!res.yesterdayReward?.done,
              },
              todayReward: {
                name:
                  res.todayReward?.name ||
                  res.rewardName ||
                  tr("None") ||
                  "None",
                icon: res.todayReward?.icon || res.rewardIcon || "",
                resourceId: res.todayReward?.resourceId || "",
                done: !!res.todayReward?.done,
              },
              nextRewards: Array.isArray(res.nextRewards)
                ? res.nextRewards.map((reward: any) => ({
                    ...reward,
                    resourceId: reward?.resourceId || "",
                  }))
                : [],
              tr,
            };

            const cardBuffer = await this.renderCardWithCache(cardPayload);
            const fileName = `auto-daily-${userId}-${fileCounter++}.png`;
            groupFileNames.push(fileName);
            groupFiles.push(
              new AttachmentBuilder(cardBuffer, { name: fileName }),
            );
          }

          cardGroups.push({
            accountIdx,
            files: groupFiles,
            fileNames: groupFileNames,
          });
        }

        // With no cards, the error message below is the only notification.
        const messages =
          cardGroups.length === 0
            ? []
            : buildCardMessages(
                cardGroups.map((group) => ({
                  files: group.files,
                  label:
                    cardGroups.length > 1
                      ? accounts[group.accountIdx]?.info?.nickname ||
                        `帳號 ${group.accountIdx + 1}`
                      : undefined,
                })),
                config.mention !== false ? `<@${userId}>` : undefined,
                true,
              );
        try {
          for (const payload of messages)
            await this.sendNotification(userId, config, payload);
        } catch (e) {
          // The sign-in itself is done and recorded; a closed DM must not undo that.
          this.logger.error(
            "Failed to send card notification: " +
              (e instanceof Error ? e.message : e),
          );
        }

        if (errorLines.length > 0) {
          const mentionPrefix =
            messages.length === 0 && config.mention !== false
              ? `<@${userId}>\n`
              : "";
          try {
            await this.sendNotification(userId, config, {
              content: mentionPrefix + errorLines.join("\n"),
            });
          } catch (e) {
            this.logger.error(
              "Failed to send error notification: " +
                (e instanceof Error ? e.message : e),
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Error processing user ${userId}: ` +
          (error instanceof Error ? error.message : error),
      );
    }
  }

  // Helper for auto-balance logic
  public async getBalancedHour(): Promise<number> {
    const dailyUsers =
      await this.client.db.findByPrefix<AutoDailyConfig>("autoDaily.");
    const hourCounts = new Array(24).fill(0);

    dailyUsers.forEach(({ value: conf }) => {
      const hour = this.normalizeHour((conf as any)?.time, -1);
      if (hour >= 0 && hour < 24) {
        hourCounts[hour]++;
      }
    });

    // Find index of min value
    let minIdx = 0;
    let minVal = hourCounts[0];
    for (let i = 1; i < 24; i++) {
      if (hourCounts[i] < minVal) {
        minVal = hourCounts[i];
        minIdx = i;
      }
    }

    return minIdx;
  }

  private async sendNotification(
    userId: string,
    config: AutoDailyConfig,
    payload: any,
  ) {
    await deliverCardMessage(this.client, userId, config, payload);
  }
}
