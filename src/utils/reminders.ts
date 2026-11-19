import { randomUUID } from "crypto";
import type { CardDetail } from "./skportApi";
import { normalizeBindingEntries } from "./accountUtils";
import { numberText, playerText, progressText, PlayerSection } from "./playerCards";
import type { NotificationDestination } from "./cardNotification";

export interface ReminderConfig extends NotificationDestination {
  version: 2; revision: string; userId: string; uid: string; roleId: string; serverId: string; name: string;
  enabled: boolean; mention: boolean; sanity: "off" | "time" | "amount"; value: number;
  daily: boolean; dailyHours: number; resetOffset?: 8 | -5;
  /** Set on rules migrated from monitorConfig: sanity "amount" threshold is max stamina minus this, resolved on the first poll. */
  legacyOffset?: number;
}
export interface ReminderState { revision?: string; sanitySent?: boolean; dailyCycle?: number; retryAt?: number; disabledReason?: string; guildLookupFails?: number }
export const reminderKey = (c: Pick<ReminderConfig, "userId" | "uid" | "serverId" | "roleId">) => `reminder.v2.${c.userId}.${c.uid}.${c.serverId}.${c.roleId}`;
export const reminderStateKey = (c: ReminderConfig) => reminderKey(c).replace("reminder.v2.", "reminderState.v2.");
export function reminderTargets(accounts: any[]): Array<{ uid: string; roleId: string; serverId: string; name: string; accountName: string }> {
  return accounts.filter((a) => !a.invalid).flatMap((a) => normalizeBindingEntries(a.roles).filter((b) => Number(b.gameId) === 3).flatMap((b) =>
    (Array.isArray(b.roles) ? b.roles : b.defaultRole ? [b.defaultRole] : []).map((r: any) => ({ uid: String(a.info?.id ?? a.info?.uid ?? ""), roleId: String(r.roleId), serverId: String(r.serverId), name: r.nickname || r.nickName || r.roleId, accountName: a.info?.nickname || a.info?.id || "SKPORT" }))))
    .filter((r, i, all) => /^\d+$/.test(r.uid) && /^\d+$/.test(r.roleId) && /^\d+$/.test(r.serverId) && all.findIndex((x) => x.uid === r.uid && x.roleId === r.roleId && x.serverId === r.serverId) === i);
}
export function serverResetOffset(name: string): 8 | -5 | undefined {
  if (/asia|亞洲|亚洲|アジア|아시아/i.test(name)) return 8;
  if (/america|europe|歐美|欧美|美洲|歐洲|欧洲|アメリカ|ヨーロッパ|아메리카|유럽/i.test(name)) return -5;
  return undefined;
}
export function nextDailyReset(now: number, offset: 8 | -5): number {
  const local = new Date(now + offset * 3600000);
  let reset = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4) - offset * 3600000;
  if (reset <= now) reset += 86400000;
  return reset;
}
export function defaultReminder(userId: string, target: ReturnType<typeof reminderTargets>[number], detail: CardDetail, legacy?: any): ReminderConfig {
  const max = Number(detail.dungeon?.maxStamina);
  return { version: 2, revision: randomUUID(), userId, uid: target.uid, roleId: target.roleId, serverId: target.serverId, name: target.name,
    enabled: false, mention: true, notify_method: legacy?.notify_method === "channel" ? "channel" : "dm", channelId: legacy?.channelId,
    sanity: legacy ? legacy.stamina_notify ? "amount" : "off" : "time",
    value: legacy?.stamina_notify && max > 0 ? Math.max(1, max - Number(legacy.stamina_offset || 10)) : 60,
    daily: legacy ? !!legacy.mission_notify : true, dailyHours: 3, resetOffset: serverResetOffset(detail.base?.serverName || "") };
}
export function validateReminder(c: ReminderConfig, detail: CardDetail): void {
  const max = Number(detail.dungeon?.maxStamina);
  if (!["off", "time", "amount"].includes(c.sanity) || !["dm", "channel"].includes(c.notify_method)) throw new Error("Invalid reminder mode");
  if (c.sanity === "time" && (!Number.isInteger(c.value) || c.value < 15 || c.value > 720)) throw new Error("理智時間須為 15–720 分鐘 / Use 15–720 minutes");
  if (c.sanity === "amount" && (!(max > 0) || !Number.isInteger(c.value) || c.value < 1 || c.value > max)) throw new Error(`理智門檻須為 1–${numberText(max)} / Invalid sanity threshold`);
  if (!Number.isInteger(c.dailyHours) || c.dailyHours < 1 || c.dailyHours > 12) throw new Error("每日提醒須為重置前 1–12 小時 / Use 1–12 hours");
  if (c.daily && c.resetOffset !== 8 && c.resetOffset !== -5) throw new Error("請確認伺服器重置時區 / Select server reset region");
  if (c.notify_method === "channel" && (!/^\d+$/.test(c.channelId || "") || !/^\d+$/.test(c.guildId || ""))) throw new Error("請重新選擇通知頻道 / Select a destination channel");
}
const numeric = (n: unknown): number => n == null || n === "" || !Number.isFinite(Number(n)) ? NaN : Number(n);
export function evaluateReminder(c: ReminderConfig, previous: ReminderState, detail: CardDetail, now = Date.now()) {
  const state: ReminderState = previous.revision === c.revision ? { ...previous } : { revision: c.revision };
  const cur = numeric(detail.dungeon?.curStamina), max = numeric(detail.dungeon?.maxStamina), fullAt = numeric(detail.dungeon?.maxTs) * 1000;
  // maxTs is supplied by SKPORT; no guessed recovery rate or server offset.
  const full = max > 0 && cur >= 0 && (cur >= max || (fullAt > 0 && fullAt <= now));
  const sanityCurrent = full ? Math.max(cur, max) : cur;
  const remaining = full ? 0 : fullAt > now ? (fullAt - now) / 60000 : NaN;
  const valid = max > 0 && cur >= 0 && (c.sanity !== "time" || Number.isFinite(remaining));
  const triggered = valid && c.sanity !== "off" && (full || (c.sanity === "time" ? remaining <= c.value : c.value <= max && cur >= c.value));
  if (valid && !triggered) state.sanitySent = false;
  const reset = c.resetOffset == null ? undefined : nextDailyReset(now, c.resetOffset);
  const daily = numeric(detail.dailyMission?.dailyActivation), dailyMax = numeric(detail.dailyMission?.maxDailyActivation);
  const ready = c.enabled && !state.disabledReason && !(state.retryAt && state.retryAt > now);
  return { state, remaining, reset, sanityCurrent,
    sanity: ready && triggered && !state.sanitySent,
    daily: ready && c.daily && daily >= 0 && dailyMax > 0 && daily < dailyMax && reset != null && reset - now <= c.dailyHours * 3600000 && state.dailyCycle !== reset };
}
export function reminderSections(c: ReminderConfig, detail: CardDetail, result: ReturnType<typeof evaluateReminder>, lang: string): PlayerSection[] {
  const t = (tw: string, en: string) => playerText(lang, tw, en);
  return [
    { title: t("理智", "Sanity"), icon: "sanity", highlighted: result.sanity, rows: [
      { label: result.sanity ? t("已達提醒條件", "Reminder threshold reached") : t("目前理智", "Current sanity"), value: progressText(result.sanityCurrent, detail.dungeon?.maxStamina) },
      { label: t("回滿時間", "Time until full"), value: result.remaining === 0 ? t("已回滿", "Full") : Number.isFinite(result.remaining) ? t(`約 ${Math.ceil(result.remaining)} 分鐘`, `About ${Math.ceil(result.remaining)} minutes`) : "—" },
    ] },
    { title: t("每日任務", "Daily activity"), icon: "daily", highlighted: result.daily, rows: [
      { label: t("活躍度", "Activity"), value: progressText(detail.dailyMission?.dailyActivation, detail.dailyMission?.maxDailyActivation) },
      { label: t("下次重置", "Next reset"), value: result.reset ? `${new Date(result.reset + (c.resetOffset || 0) * 3600000).toISOString().slice(0, 16).replace("T", " ")} UTC${c.resetOffset! >= 0 ? "+" : ""}${c.resetOffset}` : "—" },
    ] },
  ];
}

const MIN_RETRY_MS = 5 * 60000;
const MAX_RETRY_MS = 60 * 60000;
/** How far ahead of the event this rule notifies; undefined when it has no time-based lead (sanity "amount"). */
export function reminderLeadMs(c: Pick<ReminderConfig, "sanity" | "value" | "daily" | "dailyHours">): number | undefined {
  const leads: number[] = [];
  if (c.sanity === "time" && c.value > 0) leads.push(c.value * 60000);
  if (c.daily && c.dailyHours > 0) leads.push(c.dailyHours * 3600000);
  return leads.length ? Math.min(...leads) : undefined;
}
/**
 * Delay before retrying a failed check: half the lead time, kept between 5 minutes and 1 hour.
 * The lead is at least 15 minutes, so the retry is never later than the lead itself.
 */
export function retryDelayMs(c: Pick<ReminderConfig, "sanity" | "value" | "daily" | "dailyHours">): number {
  const lead = reminderLeadMs(c);
  const half = lead === undefined ? MAX_RETRY_MS : lead / 2;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, half));
}
/** Resolves the legacy "distance to full" into an absolute sanity threshold once the real maximum is known. */
export function resolveLegacyThreshold(c: ReminderConfig, detail: CardDetail): ReminderConfig | null {
  if (c.legacyOffset == null || c.sanity !== "amount") return null;
  const max = Number(detail.dungeon?.maxStamina);
  if (!(max > 0)) return null;
  return { ...c, value: Math.min(max, Math.max(1, Math.round(max - c.legacyOffset))), legacyOffset: undefined };
}
