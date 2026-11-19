import { ProfileTemplateService } from "./ProfileTemplateService";
import { AttachmentBuilder } from "discord.js";
import { ExtendedClient } from "../structures/Client";
import { getAccounts, withAutoRefresh } from "../utils/accountUtils";
import { getCardDetail } from "../utils/skportApi";
import { findProfileAccount } from "../utils/profileView";
import { buildCardMessages, deliverCardMessage } from "../utils/cardNotification";
import { drawPlayerCard, playerText } from "../utils/playerCards";
import { evaluateReminder, ReminderConfig, ReminderState, reminderSections, reminderStateKey, validateReminder } from "../utils/reminders";
import { Logger } from "../utils/Logger";

export class MonitorService {
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private logger = new Logger("Reminder");
  constructor(private client: ExtendedClient) {}
  start() {
    if (this.interval || this.client.cluster.id !== 0) return;
    this.interval = setInterval(() => void this.runMonitoring(), 15 * 60000);
    void this.runMonitoring();
    this.logger.success("Service started (15 minutes; saved v2 rules only).");
  }
  async runMonitoring() {
    if (this.isRunning || this.client.cluster.id !== 0 || !this.client.isReady()) return;
    this.isRunning = true;
    try {
      // Old monitorConfig entries remain untouched and inactive until wizard save.
      for (const { id, value: config } of await this.client.db.findByPrefix<ReminderConfig>("reminder.v2.")) {
        if (config.version !== 2 || !config.enabled) continue;
        const stateKey = reminderStateKey(config);
        const previous = await this.client.db.get<ReminderState>(stateKey) || {};
        if (previous.revision === config.revision && (previous.disabledReason || (previous.retryAt || 0) > Date.now())) continue;
        let state: ReminderState = previous.revision === config.revision ? previous : { revision: config.revision };
        try {
          const account = findProfileAccount(await getAccounts(this.client.db, config.userId), { ...config, ownerId: config.userId });
          if (!account || account.invalid) throw Object.assign(new Error("Account or role unavailable"), { permanent: true });
          const lang = await this.client.db.get<string>(`${config.userId}.locale`) || "tw";
          const response = await withAutoRefresh(this.client, config.userId, account, (cred, salt, options) => getCardDetail(config.roleId, config.serverId, config.uid, lang, cred, salt, options), lang);
          if (response?.code !== 0 || !response.data?.detail) throw new Error("SKPORT player data unavailable");
          const detail = response.data.detail;
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
          const permanent = error.permanent || [10003, 10004, 10007, 50001, 50007, 50013].includes(Number(error.code));
          if (permanent) state.disabledReason = "帳號或通知目的地無法使用，請重新儲存設定 / Account or destination unavailable; save settings again";
          else state.retryAt = Date.now() + 3600000;
          this.logger.warn(`Reminder ${permanent ? "paused" : "retry in one hour"} (${error.code || "upstream"}).`);
        }
        const latest = await this.client.db.get<ReminderConfig>(id);
        if (latest?.revision === config.revision) await this.client.db.set(stateKey, state);
      }
    } catch (error) { this.logger.error(`Monitoring loop failed: ${error}`); }
    finally { this.isRunning = false; }
  }
  register() { this.client.startup.onPrimary("reminder-service", () => this.start()); }
  stop() { if (this.interval) clearInterval(this.interval); this.interval = null; }
}
