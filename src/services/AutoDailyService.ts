import { ExtendedClient } from "../structures/Client";
import { formatSkGameRole, getGamePlayerBinding } from "../utils/skportApi";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../utils/accountUtils";
import { createTranslator } from "../utils/i18n";
import { AttachmentBuilder } from "discord.js";
import moment from "moment-timezone";
import { Logger } from "../utils/Logger";
import { processRoleAttendance } from "../utils/attendanceUtils";
import {
  buildDailyAttendanceCard,
  DailyCardPayload,
} from "../utils/dailyCanvasUtils";
import { Readable } from "stream";

type DailyGameScope = "endfield" | "arknights" | "both";
const AUTO_DAILY_SUPPORTED_GAME_IDS = new Set([1, 3]);

interface AutoDailyConfig {
  time: number; // 0-23
  auto_balance: boolean;
  notify: boolean;
  notify_method: "dm" | "channel";
  channelId?: string;
  mention?: boolean;
  game_scope?: DailyGameScope;
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

  private normalizeAttendanceBindings(
    raw: any,
    scope: DailyGameScope,
  ): Array<{ gameId: number; roles: any[] }> {
    const normalized: Array<{ gameId: number; roles: any[] }> = [];

    const pushBinding = (entry: any) => {
      const gameId = Number(entry?.gameId || 0);
      if (!AUTO_DAILY_SUPPORTED_GAME_IDS.has(gameId)) return;
      if (!this.isGameInScope(gameId, scope)) return;

      let roles = Array.isArray(entry?.roles)
        ? entry.roles
        : entry?.defaultRole
          ? [entry.defaultRole]
          : [];

      if (
        roles.length === 0 &&
        gameId === 1 &&
        (entry?.uid || entry?.nickName)
      ) {
        roles = [
          {
            roleId: String(entry?.uid || ""),
            serverId: String(entry?.channelMasterId || ""),
            nickname: String(entry?.nickName || entry?.uid || "Arknights"),
            level: 0,
            serverName: String(entry?.channelName || entry?.gameName || "-"),
          },
        ];
      }

      if (roles.length > 0) {
        normalized.push({ gameId, roles });
      }
    };

    if (!Array.isArray(raw)) return normalized;

    for (const item of raw) {
      if (Array.isArray(item?.bindingList)) {
        for (const binding of item.bindingList) {
          pushBinding(binding);
        }
        continue;
      }
      pushBinding(item);
    }

    return normalized;
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

  private isGameInScope(gameId: number, scope: DailyGameScope): boolean {
    if (scope === "both") return gameId === 1 || gameId === 3;
    if (scope === "arknights") return gameId === 1;
    return gameId === 3;
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
      const currentHour =
        targetHour !== undefined
          ? targetHour
          : parseInt(moment().tz("Asia/Taipei").format("H"));
      this.logger.info(
        `Running checks for hour ${currentHour}:00 (Asia/Taipei)`,
      );

      // Migrate to prefixed keys
      const dailyUsers =
        await this.client.db.findByPrefix<AutoDailyConfig>("autoDaily.");

      const eligibleUsers = [];
      for (const { id, value: config } of dailyUsers) {
        if (!config || typeof config !== "object") continue;

        const normalizedTime = this.normalizeHour((config as any).time, 13);
        const normalizedNotifyMethod =
          (config as any).notify_method === "channel" ? "channel" : "dm";
        const normalizedMention = (config as any).mention !== false;
        const normalizedGameScope = this.normalizeGameScope(
          (config as any).game_scope,
          "arknights",
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
        if ((config as any).time !== currentHour) continue;

        eligibleUsers.push({ userId, config });
      }

      this.logger.info(`Found ${eligibleUsers.length} users for this hour.`);

      for (const { userId, config } of eligibleUsers) {
        await this.processUser(userId, config);
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

  public async processUser(userId: string, config: AutoDailyConfig) {
    try {
      const today = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
      // Atomically claim today's slot — guards against concurrent cluster processes
      // (graceful recluster can briefly run two cluster-0s simultaneously).
      if (!this.client.db.claimSlot(`${userId}.lastAutoDaily`, today)) {
        this.logger.info(
          `Skipping user ${userId}: already processed for ${today}.`,
        );
        return;
      }

      const accounts = await getAccounts(this.client.db, userId);
      if (!accounts || accounts.length === 0) return;

      let successCount = 0;
      let alreadySignedCount = 0;
      let failCount = 0;
      this.logger.info(`Starting auto-daily processing for user ${userId}`);
      const results: {
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
        isError?: boolean;
        accountIdx?: number;
      }[] = [];

      const processedRoles = new Set<string>();

      const userLang = (await this.client.db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];

        try {
          // Always attempt account validation/recovery, even if previously marked invalid.
          // ensureAccountBinding will try all 3 refresh steps and clear the invalid flag if successful.
          await ensureAccountBinding(account, userId, this.client.db, tr.lang);

          if (account.invalid) {
            // Still invalid after recovery attempt — token is truly expired
            this.logger.warn(
              `Skipping unrecoverable account for user ${userId}: ${account.info?.nickname} (${account.info?.id})`,
            );
            results.push({
              ...this.makeErrorResult(
                account.info?.nickname || "Unknown",
                tr("TokenExpired"),
              ),
              accountIdx: i,
            });
            failCount++;
            continue;
          }

          const gameScope = this.normalizeGameScope(
            config.game_scope,
            "arknights",
          );

          let roles = this.normalizeAttendanceBindings(
            account.roles,
            gameScope,
          );
          try {
            const liveBindings = await withAutoRefresh(
              this.client,
              userId,
              account,
              (c: string, s: string, options: any) =>
                getGamePlayerBinding(account.cookie, tr.lang, c, s, options),
              tr.lang,
            );
            const liveRoles = this.normalizeAttendanceBindings(
              liveBindings,
              gameScope,
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
            results.push({
              ...this.makeErrorResult(
                account.info?.nickname || "Unknown",
                tr("TokenExpired"),
              ),
              accountIdx: i,
            });
            failCount++;
            continue;
          }

          if (!roles || roles.length === 0) {
            results.push({
              ...this.makeErrorResult(
                account.info?.nickname || "Unknown",
                tr("Error") || "No roles found",
              ),
              accountIdx: i,
            });
            failCount++;
            continue;
          }

          for (const binding of roles) {
            for (const role of binding.roles) {
              const gameId = binding.gameId || 3;
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
                  const isArknights = Number(gameId) === 1;
                  const roleName = `${res.nickname}`;
                  const roleMeta = isArknights
                    ? `${role.serverName || "-"}`
                    : `Lv.${res.level} - ${role.serverName || "-"}`;

                  if (res.signedNow) successCount++;
                  else if (res.hasToday) alreadySignedCount++;
                  else if (res.error) failCount++;

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
                    status: res.signedNow
                      ? tr("daily_Success")
                      : tr("daily_StatusAlready"),
                    isError: !!res.error && !res.signedNow && !res.hasToday,
                    accountIdx: i,
                  });

                  this.logger.info(
                    `User ${userId} - Role ${res.nickname} (${res.uid}): ${res.signedNow ? "SUCCESS" : res.hasToday ? "ALREADY SIGNED" : "ERROR"}` +
                      (res.signedNow ? ` (Reward: ${displayedReward})` : ""),
                  );
                }
              } catch (roleError) {
                this.logger.error(
                  `Error processing role ${gameRoleStr} for user ${userId}: ${roleError}`,
                );
                results.push({
                  ...this.makeErrorResult(
                    role.nickname || "Unknown",
                    tr("Error"),
                  ),
                  accountIdx: i,
                });
                failCount++;
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
            accountIdx: i,
          });
          failCount++;
        }
      }

      this.logger.info(
        `Finished auto-daily for user ${userId}. Result: ${successCount} success, ${alreadySignedCount} already signed, ${failCount} failed.`,
      );

      if (config.notify && results.length > 0) {
        // Group non-error results by account, preserving order
        const accountGroups = new Map<number, { res: (typeof results)[0]; idx: number }[]>();
        const errorLines: string[] = [];

        for (const [idx, res] of results.entries()) {
          const accountIdx = res.accountIdx ?? 0;
          if (!res.isError) {
            if (!accountGroups.has(accountIdx)) accountGroups.set(accountIdx, []);
            accountGroups.get(accountIdx)!.push({ res, idx });
          } else {
            errorLines.push(`- ${res.roleName}: ${res.status}`);
          }
        }

        let isFirstNotification = true;

        for (const entries of accountGroups.values()) {
          const files: AttachmentBuilder[] = [];

          for (const { res, idx } of entries) {
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
            files.push(
              new AttachmentBuilder(cardBuffer, {
                name: `auto-daily-${userId}-${idx}.png`,
              }),
            );
          }

          // First account: include mention; subsequent accounts: include separator
          let content: string | undefined;
          if (isFirstNotification && config.mention !== false) {
            content = `<@${userId}>`;
          } else if (!isFirstNotification) {
            content = "───────────────";
          }

          try {
            await this.sendNotification(userId, config, { content, files });
          } catch (e) {
            this.logger.error(
              "Failed to send card notification: " +
                (e instanceof Error ? e.message : e),
            );
          }

          isFirstNotification = false;
        }

        if (errorLines.length > 0) {
          const mentionPrefix =
            isFirstNotification && config.mention !== false
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
    const notifyMethod = config.notify_method;
    const channelId = config.channelId;

    try {
      if (notifyMethod === "dm") {
        let user = this.client.users.cache.get(userId);
        if (!user) {
          user = await this.client.users.fetch(userId);
        }
        const dmChannel = await user.createDM();
        await dmChannel.send(payload);
        return;
      }

      if (notifyMethod === "channel" && channelId) {
        const channelPresence = await this.client.cluster.broadcastEval(
          (c: any, context: any) => c.channels.cache.has(context.channelId),
          { context: { channelId } },
        );

        const targetCluster = channelPresence.findIndex(Boolean);
        if (targetCluster < 0) {
          this.logger.warn(
            `No cluster has channel ${channelId} in cache. Skip notification for user ${userId}.`,
          );
          return;
        }

        // Serialize files to base64 to pass through broadcastEval.
        // AttachmentBuilder bytes are stored on `attachment`, not always on `data`.
        const serializeAttachment = async (file: AttachmentBuilder) => {
          const attachment = (file as any).attachment;
          let buffer = Buffer.alloc(0);

          if (Buffer.isBuffer(attachment)) {
            buffer = Buffer.from(attachment);
          } else if (attachment instanceof Uint8Array) {
            buffer = Buffer.from(attachment);
          } else if (attachment instanceof Readable) {
            const chunks: Buffer[] = [];
            for await (const chunk of attachment) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            buffer = Buffer.concat(chunks);
          }

          return {
            buffer: buffer.toString("base64"),
            name: file.name,
            description: file.description,
          };
        };

        const serializedFiles = payload.files
          ? await Promise.all(
              payload.files.map((file: AttachmentBuilder) =>
                serializeAttachment(file),
              ),
            )
          : [];

        const serializedPayload = {
          content: payload.content,
          files: serializedFiles,
        };

        await this.client.cluster.broadcastEval(
          async (c: any, context: any) => {
            const channel = c.channels.cache.get(context.channelId);
            if (!channel) return false;

            // Reconstruct AttachmentBuilder objects from serialized data
            const { AttachmentBuilder } = await import("discord.js");
            const reconstructedFiles = context.payload.files.map(
              (file: any) =>
                new AttachmentBuilder(Buffer.from(file.buffer, "base64"), {
                  name: file.name,
                  description: file.description,
                }),
            );

            await channel.send({
              content: context.payload.content,
              files: reconstructedFiles,
            });
            return true;
          },
          {
            cluster: targetCluster,
            context: {
              channelId,
              payload: serializedPayload,
            },
          },
        );
      }
    } catch (e) {
      this.logger.error(
        "Failed to broadcast notification: " +
          (e instanceof Error ? e.message : e),
      );
    }
  }
}
