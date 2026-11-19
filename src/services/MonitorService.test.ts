import assert from "node:assert/strict";
import { CustomDatabase } from "../utils/Database";
import { MonitorService } from "./MonitorService";
import { reminderKey, reminderStateKey, ReminderConfig } from "../utils/reminders";

import { toggleRule } from "../utils/reminderList";
import { migrateLegacyMonitorConfig } from "../utils/reminderMigration";

const accountUtils = require("../utils/accountUtils");
const cardNotification = require("../utils/cardNotification");
const playerCards = require("../utils/playerCards");
const skport = require("../utils/skportApi");

const rule = (userId: string, uid: string, roleId: string, extra: Partial<ReminderConfig> = {}): ReminderConfig => ({
  version: 2,
  revision: "rev-" + userId + roleId,
  userId,
  uid,
  roleId,
  serverId: "2",
  name: "role" + roleId,
  enabled: true,
  mention: false,
  notify_method: "dm",
  // never triggers with the detail below: threshold above the current sanity
  sanity: "amount",
  value: 200,
  daily: false,
  dailyHours: 3,
  ...extra,
});

const account = (uid: string, roleIds: string[]) => ({
  info: { id: uid },
  roles: [{ gameId: 3, roles: roleIds.map((roleId) => ({ roleId, serverId: "2", nickname: "n" + roleId })) }],
});

async function main() {
  const db = new CustomDatabase(":memory:");
  const originals = [accountUtils.getAccounts, accountUtils.withAutoRefresh, skport.getCardDetail];
  const accountLoads: string[] = [];
  const detailLoads: string[] = [];
  const userAccounts: Record<string, any[]> = {
    "10": [account("1001", ["7", "8"])],
    "11": [account("1001", ["7"])], // a second Discord user linked the same SKPORT account
  };
  try {
    accountUtils.getAccounts = async (_db: any, userId: string) => {
      accountLoads.push(userId);
      return userAccounts[userId] || [];
    };
    accountUtils.withAutoRefresh = async (_c: any, _u: any, _a: any, request: any) => request("c", "s", {});
    skport.getCardDetail = async (roleId: string) => {
      detailLoads.push(roleId);
      return {
        code: 0,
        data: { detail: { dungeon: { curStamina: "10", maxStamina: "240", maxTs: "0" }, dailyMission: { dailyActivation: 100, maxDailyActivation: 100 }, base: { serverName: "Asia" } } },
      };
    };
    const rules = [rule("10", "1001", "7"), rule("10", "1001", "8"), rule("11", "1001", "7")];
    for (const r of rules) await db.set(reminderKey(r), r);
    const service = new MonitorService({ db, cluster: { id: 0 }, isReady: () => true } as any);

    await service.runMonitoring();
    assert.deepEqual(accountLoads.sort(), ["10", "11"], "accounts are loaded once per user per pass, not once per rule");
    assert.deepEqual(detailLoads.sort(), ["7", "8"], "card/detail once per role per pass; the shared role is fetched once");
    for (const r of rules) assert.equal((await db.get<any>(reminderStateKey(r))).revision, r.revision);

    // a new pass starts with a fresh memo
    await service.runMonitoring();
    assert.equal(detailLoads.length, 4);

    // a failed fetch is retried after min(1h, lead/2) with a floor of 5 minutes, not a flat hour
    skport.getCardDetail = async () => {
      throw new Error("503");
    };
    const short = rule("12", "1002", "9", { sanity: "time", value: 15 });
    userAccounts["12"] = [account("1002", ["9"])];
    await db.set(reminderKey(short), short);
    const before = Date.now();
    await service.runMonitoring();
    const state = await db.get<any>(reminderStateKey(short));
    const delay = state.retryAt - before;
    assert.ok(delay >= 7.5 * 60000 - 1000 && delay <= 7.5 * 60000 + 5000, `retry in ~7.5 min, got ${delay}`);

    // a migrated legacy rule gets its real threshold on the first poll, keeping its revision
    skport.getCardDetail = async () => ({
      code: 0,
      data: { detail: { dungeon: { curStamina: "10", maxStamina: "240", maxTs: "0" }, dailyMission: { dailyActivation: 100, maxDailyActivation: 100 } } },
    });
    const legacy = rule("13", "1003", "5", { value: 1, legacyOffset: 30 });
    userAccounts["13"] = [account("1003", ["5"])];
    await db.set(reminderKey(legacy), legacy);
    await service.runMonitoring();
    const patched = await db.get<ReminderConfig>(reminderKey(legacy));
    assert.equal(patched!.value, 210);
    assert.equal(patched!.legacyOffset, undefined);
    assert.equal(patched!.revision, legacy.revision);

    // ---- a migrated channel rule: paused = never evaluated; resumed = baseline first, then only a new crossing sends
    const sends: string[] = [];
    let cur = "230";
    cardNotification.deliverCardMessage = async (_c: any, userId: string) => void (userId === "20" && sends.push(userId));
    playerCards.drawPlayerCard = async () => Buffer.from("x");
    let fetches = 0;
    skport.getCardDetail = async (roleId: string) => {
      if (roleId === "3") fetches++;
      return { code: 0, data: { detail: { dungeon: { curStamina: cur, maxStamina: "240", maxTs: "0" }, dailyMission: { dailyActivation: 100, maxDailyActivation: 100 } } } };
    };
    userAccounts["20"] = [account("2001", ["3"])];
    await db.set("monitorConfig", { "20": { stamina_notify: true, stamina_offset: 30, mission_notify: false, notify_method: "channel", channelId: "555" } });
    await migrateLegacyMonitorConfig(db, async (u) => userAccounts[u] || []);
    const migratedKey = "reminder.v2.20.2001.2.3";
    const mig = await db.get<ReminderConfig>(migratedKey);
    assert.deepEqual([mig!.enabled, mig!.notify_method, mig!.channelId], [false, "channel", "555"]);
    const client: any = { db, cluster: { id: 0 }, isReady: () => true, channels: { cache: new Map([["555", { guildId: "9" }]]) } };
    const svc2 = new MonitorService(client);
    const fetchesBefore = fetches;
    await svc2.runMonitoring();
    await svc2.runMonitoring();
    assert.equal(sends.length, 0, "paused migrated rule sends nothing over two passes");
    assert.equal(fetches, fetchesBefore, "...and is not even evaluated");
    // resume with the sanity already above the threshold (210): first pass only records it
    assert.equal(toggleRule(client, "20", "2001.2.3"), true);
    await svc2.runMonitoring();
    assert.equal(sends.length, 0, "no send on the first pass after resume");
    assert.equal((await db.get<ReminderConfig>(migratedKey))!.baselinePending, undefined);
    await svc2.runMonitoring();
    assert.equal(sends.length, 0, "still above threshold: already notified/baselined");
    cur = "100";
    await svc2.runMonitoring();
    cur = "230";
    await svc2.runMonitoring();
    assert.deepEqual(sends, ["20"], "a new crossing sends once");
  } finally {
    [accountUtils.getAccounts, accountUtils.withAutoRefresh, skport.getCardDetail] = originals;
  }
  console.log("MonitorService tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
