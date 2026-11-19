import { randomUUID } from "crypto";
import type { CustomDatabase } from "./Database";
import { ReminderConfig, reminderKey, reminderTargets } from "./reminders";

export const REMINDER_MIGRATION_MARKER = "migration.reminder_v2.v1";

/** Shape the old `/monitor` command stored: `monitorConfig[userId]`. */
export interface LegacyMonitorConfig {
  stamina_notify?: boolean;
  stamina_offset?: number;
  mission_notify?: boolean;
  notify_method?: "dm" | "channel";
  channelId?: string;
}

/** Legacy daily reminders fired 3 hours before the 04:00 (UTC+8) reset. */
const LEGACY_DAILY_HOURS = 3;
const LEGACY_RESET_OFFSET = 8;
const LEGACY_DEFAULT_OFFSET = 10;

/**
 * v2 rule equivalent to a legacy `monitorConfig` entry for one role, or null
 * when the legacy entry had nothing switched on. Two inputs only exist at
 * runtime and are resolved by the monitor service on the first poll:
 *   - `legacyOffset` -> sanity threshold (needs the role's real max sanity)
 *   - `guildId` of a channel destination (needs the cluster that owns it)
 */
export function legacyToReminder(
  userId: string,
  target: { uid: string; roleId: string; serverId: string; name: string },
  legacy: LegacyMonitorConfig,
): ReminderConfig | null {
  const sanity = !!legacy.stamina_notify;
  const daily = !!legacy.mission_notify;
  if (!sanity && !daily) return null;
  const channel =
    legacy.notify_method === "channel" && /^\d+$/.test(String(legacy.channelId || ""));
  const offset = Number(legacy.stamina_offset);
  return {
    version: 2,
    revision: randomUUID(),
    userId,
    uid: target.uid,
    roleId: target.roleId,
    serverId: target.serverId,
    name: target.name,
    enabled: true,
    mention: channel,
    notify_method: channel ? "channel" : "dm",
    channelId: channel ? String(legacy.channelId) : undefined,
    sanity: sanity ? "amount" : "off",
    value: 1,
    legacyOffset: sanity
      ? Number.isFinite(offset) && offset >= 0
        ? offset
        : LEGACY_DEFAULT_OFFSET
      : undefined,
    daily,
    dailyHours: LEGACY_DAILY_HOURS,
    resetOffset: LEGACY_RESET_OFFSET,
  };
}

/**
 * Converts every legacy `monitorConfig` entry into `reminder.v2.*` rules, one
 * per account (its first Endfield role, as the old service did). Idempotent and
 * non-destructive: the legacy map stays, existing rules are never overwritten,
 * and a marker prevents a rule the user deleted from coming back.
 */
export async function migrateLegacyMonitorConfig(
  db: CustomDatabase,
  getAccounts: (userId: string) => Promise<any[]>,
): Promise<{ users: number; created: number; skipped: boolean }> {
  if (await db.get(REMINDER_MIGRATION_MARKER))
    return { users: 0, created: 0, skipped: true };
  const legacy =
    (await db.get<Record<string, LegacyMonitorConfig>>("monitorConfig")) || {};
  let users = 0;
  let created = 0;
  for (const [userId, config] of Object.entries(legacy)) {
    if (!config || typeof config !== "object" || !/^\d+$/.test(userId)) continue;
    let accounts: any[];
    try {
      accounts = await getAccounts(userId);
    } catch {
      continue;
    }
    const firstPerAccount = new Map<string, ReturnType<typeof reminderTargets>[number]>();
    for (const t of reminderTargets(accounts))
      if (!firstPerAccount.has(t.uid)) firstPerAccount.set(t.uid, t);
    let touched = false;
    for (const target of firstPerAccount.values()) {
      const rule = legacyToReminder(userId, target, config);
      if (!rule) continue;
      const key = reminderKey(rule);
      const wrote = db.transaction((store) => {
        if (store.get(key)) return false;
        store.set(key, rule);
        return true;
      });
      if (wrote) {
        created++;
        touched = true;
      }
    }
    if (touched) users++;
  }
  await db.set(REMINDER_MIGRATION_MARKER, { at: Date.now(), users, created });
  return { users, created, skipped: false };
}

/** Memoizes async work by key for one pass; a rejected result is shared by every caller of that key. */
export function createPassCache() {
  const cache = new Map<string, Promise<any>>();
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      let hit = cache.get(key);
      if (!hit) {
        hit = load();
        cache.set(key, hit);
      }
      return hit as Promise<T>;
    },
    size: () => cache.size,
  };
}
