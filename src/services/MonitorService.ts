import { ProfileTemplateService } from "./ProfileTemplateService";
import { AttachmentBuilder } from "discord.js";
import { ExtendedClient } from "../structures/Client";
import { getAccounts, withAutoRefresh } from "../utils/accountUtils";
import { getCardDetail } from "../utils/skportApi";
import { findProfileAccount } from "../utils/profileView";
import { buildCardMessages, deliverCardMessage } from "../utils/cardNotification";
import { drawPlayerCard, playerText } from "../utils/playerCards";
import {
  evaluateReminder,
  ReminderConfig,
  ReminderState,
  reminderSections,
  reminderStateKey,
  resolveLegacyThreshold,
  retryDelayMs,
  validateReminder,
} from "../utils/reminders";
import {
  createPassCache,
  migrateLegacyMonitorConfig,
} from "../utils/reminderMigration";
import { Logger } from "../utils/Logger";

/** A channel whose guild cannot be found this many polls in a row is treated as gone. */
const MAX_GUILD_LOOKUP_FAILS = 6;

export class MonitorService {
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private logger = new Logger("Reminder");
  constructor(private client: ExtendedClient) {}

  /**
   * Primary cluster only: convert legacy monitorConfig subscribers first, then
   * start polling so the first pass already sees the converted rules.
   */
  register() {
    this.client.startup.onPrimary("reminder-service", async () => {
      try {
        const r = await migrateLegacyMonitorConfig(this.client.db, (userId) =>
          getAccounts(this.client.db, userId),
        );
        if (!r.skipped)
          this.logger.info(
            `Converted ${r.created} legacy monitor rules for ${r.users} users.`,
          );
      } catch (error: any) {
        this.logger.error(`Legacy monitor migration failed: ${error?.message || error}`);
      }
      this.start();
    });
  }

  start() {
    if (this.interval || this.client.cluster.id !== 0) return;
    this.interval = setInterval(() => void this.runMonitoring(), 15 * 60000);
    void this.runMonitoring();
    this.logger.success("Service started (15 minutes; saved v2 rules only).");
  }

  /** Channel -> guild id; null = no cluster knows the channel, undefined = lookup failed. */
  private async resolveChannelGuild(channelId: string): Promise<string | null | undefined> {
    const local: any = this.client.channels.cache.get(channelId);
    if (local?.guildId) return local.guildId;
    try {
      const results: Array<string | null> = await this.client.cluster.broadcastEval(
        (c: any, ctx: { id: string }) => {
          const channel = c.channels.cache.get(ctx.id);
          return channel && channel.guildId ? channel.guildId : null;
        },
        { context: { id: channelId }, timeout: 10000 },
      );
      return results.find(Boolean) ?? null;
    } catch {
      return undefined;
    }
  }

  async runMonitoring() {
    if (this.isRunning || this.client.cluster.id !== 0 || !this.client.isReady()) return;
    this.isRunning = true;
    // One pass: each user's accounts and each role's card/detail are fetched at most once.
    const pass = createPassCache();
    try {
      for (const { id, value: stored } of await this.client.db.findByPrefix<ReminderConfig>("reminder.v2.")) {
        if (stored.version !== 2 || !stored.enabled) continue;
        let config = stored;
        const stateKey = reminderStateKey(config);
        const previous = await this.client.db.get<ReminderState>(stateKey) || {};
        if (previous.revision === config.revision && (previous.disabledReason || (previous.retryAt || 0) > Date.now())) continue;
        let state: ReminderState = previous.revision === config.revision ? previous : { revision: config.revision };
        // Patch the stored rule without touching its revision (state stays valid).
        const patchRule = (patch: Partial<ReminderConfig>) => {
          config = { ...config, ...patch };
          this.client.db.update<ReminderConfig>(id, (cur) =>
            cur && cur.revision === stored.revision ? { ...cur, ...patch } : cur,
          );
        };
        try {
          const accounts = await pass.get(`accounts:${config.userId}`, () => getAccounts(this.client.db, config.userId));
          const account = findProfileAccount(accounts, { ...config, ownerId: config.userId });
          if (!account || account.invalid) throw Object.assign(new Error("Account or role unavailable"), { permanent: true });
          const lang = await pass.get(`lang:${config.userId}`, async () => (await this.client.db.get<string>(`${config.userId}.locale`)) || "tw");

          if (config.notify_method === "channel" && !config.guildId && config.channelId) {
            const guildId = await this.resolveChannelGuild(config.channelId);
            if (!guildId) throw Object.assign(new Error("Destination channel not found"), { guildLookup: true });
            patchRule({ guildId });
            state.guildLookupFails = undefined;
          }

          // card/detail is per role: share it between rules that point at the same role.
          const response = await pass.get(`detail:${config.uid}|${config.serverId}|${config.roleId}|${lang}`, () =>
            withAutoRefresh(this.client, config.userId, account, (cred, salt, options) => getCardDetail(config.roleId, config.serverId, config.uid, lang, cred, salt, options), lang));
          if (response?.code !== 0 || !response.data?.detail) throw new Error("SKPORT player data unavailable");
          const detail = response.data.detail;
          const resolved = resolveLegacyThreshold(config, detail);
          if (resolved) patchRule({ value: resolved.value, legacyOffset: undefined });
          validateReminder(config, detail);
          const result = evaluateReminder(config, state, detail);
          state = result.state;
          if (result.sanity || result.daily) {
            const image = await drawPlayerCard(detail, playerText(lang, "理智與每日任務提醒", "Sanity & daily reminder"), reminderSections(config, detail, result, lang), lang, Date.now(), await ProfileTemplateService.getUserTemplate(this.client.db, config.userId));
            const latest = await this.client.db.get<ReminderConfig>(id);
            if (!latest?.enabled || latest.revision !== config.revision) continue;
            const [payload] = buildCardMessages([{ files: [new AttachmentBuilder(image, { name: "reminder.webp" })] }], config.mention ? `<@${config.userId}>` : undefined);
            await deliverCardMessage(this.client, config.userId, config, payload);
            if (result.sanity) state.sanitySent = true;
            if (result.daily) state.dailyCycle = result.reset;
            state.retryAt = undefined;
            this.logger.info(`Delivered reminder (${result.sanity ? "sanity" : ""}${result.daily ? " daily" : ""}).`);
          }
        } catch (error: any) {
          let permanent = error.permanent || [10003, 10004, 10007, 50001, 50007, 50013].includes(Number(error.code));
          if (error.guildLookup) {
            state.guildLookupFails = (state.guildLookupFails || 0) + 1;
            permanent = permanent || state.guildLookupFails >= MAX_GUILD_LOOKUP_FAILS;
          }
          if (permanent) state.disabledReason = "帳號或通知目的地無法使用，請重新儲存設定 / Account or destination unavailable; save settings again";
          else state.retryAt = Date.now() + retryDelayMs(config);
          this.logger.warn(`Reminder ${permanent ? "paused" : `retry in ${Math.round(retryDelayMs(config) / 60000)} min`} (${error.code || "upstream"}).`);
        }
        // Check-and-write in one transaction: a rule edited or deleted meanwhile (any cluster) keeps its fresh state.
        this.client.db.transaction((store) => {
          if (store.get<ReminderConfig>(id)?.revision === config.revision) store.set(stateKey, state);
        });
      }
    } catch (error) { this.logger.error(`Monitoring loop failed: ${error}`); }
    finally { this.isRunning = false; }
  }
  stop() { if (this.interval) clearInterval(this.interval); this.interval = null; }
}
