import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";
import {
  REMINDER_MIGRATION_MARKER,
  createPassCache,
  legacyToReminder,
  migrateLegacyMonitorConfig,
} from "./reminderMigration";
import {
  ReminderConfig,
  reminderKey,
  reminderLeadMs,
  resolveLegacyThreshold,
  retryDelayMs,
  validateReminder,
} from "./reminders";

let counter = 0;
async function withDb(fn: (db: CustomDatabase) => Promise<void>) {
  const file = path.join(os.tmpdir(), "ef-rem-test-" + process.pid + "-" + counter++ + ".sqlite");
  const db = new CustomDatabase(file);
  try {
    await fn(db);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
}

const account = (id: string, ...roles: Array<[string, string, string]>) => ({
  info: { id, nickname: "acc" + id },
  roles: [
    {
      gameId: 3,
      roles: roles.map(([roleId, serverId, nickname]) => ({ roleId, serverId, nickname })),
    },
  ],
});

async function main() {
  // ---- retry delay: half the lead time, within [5 min, 1 h], never longer than the lead
  const base = { sanity: "off" as const, value: 60, daily: false, dailyHours: 3 };
  const min = 60000;
  assert.equal(retryDelayMs({ ...base, sanity: "time", value: 15 }), 7.5 * min);
  assert.equal(retryDelayMs({ ...base, sanity: "time", value: 30 }), 15 * min);
  assert.equal(retryDelayMs({ ...base, sanity: "time", value: 240 }), 60 * min, "capped at one hour");
  assert.equal(retryDelayMs({ ...base, daily: true, dailyHours: 1 }), 30 * min);
  assert.equal(retryDelayMs({ ...base, daily: true, dailyHours: 12 }), 60 * min);
  assert.equal(retryDelayMs({ ...base, sanity: "time", value: 15, daily: true, dailyHours: 12 }), 7.5 * min, "the shorter lead wins");
  assert.equal(retryDelayMs({ ...base, sanity: "amount", value: 200 }), 60 * min, "no time lead: the cap");
  for (const value of [15, 20, 60, 720])
    for (const dailyHours of [1, 3, 12]) {
      const c = { ...base, sanity: "time" as const, value, daily: true, dailyHours };
      assert.ok(retryDelayMs(c) <= reminderLeadMs(c)!, "retry is never longer than the lead");
      assert.ok(retryDelayMs(c) >= 5 * min);
    }

  // ---- legacy rule conversion
  const legacyDm = { stamina_notify: true, stamina_offset: 20, mission_notify: true, notify_method: "dm" as const, channelId: "555" };
  const rule = legacyToReminder("99", { uid: "1001", roleId: "7", serverId: "2", name: "Role" }, legacyDm)!;
  assert.equal(rule.version, 2);
  assert.equal(rule.enabled, true);
  assert.equal(rule.sanity, "amount");
  assert.equal(rule.legacyOffset, 20);
  assert.equal(rule.daily, true);
  assert.equal(rule.dailyHours, 3);
  assert.equal(rule.resetOffset, 8, "legacy reset was 04:00 UTC+8");
  assert.equal(rule.notify_method, "dm");
  assert.equal(rule.channelId, undefined);
  assert.equal(reminderKey(rule), "reminder.v2.99.1001.2.7");
  validateReminder(rule, { dungeon: { maxStamina: "360" } } as any); // a migrated rule passes validation as stored
  const resolved = resolveLegacyThreshold(rule, { dungeon: { maxStamina: "360" } } as any)!;
  assert.equal(resolved.value, 340);
  assert.equal(resolved.legacyOffset, undefined);
  assert.equal(resolveLegacyThreshold(resolved, { dungeon: { maxStamina: "360" } } as any), null, "resolved once");
  assert.equal(resolveLegacyThreshold(rule, { dungeon: { maxStamina: "0" } } as any), null, "unknown max: wait");
  assert.equal(
    resolveLegacyThreshold({ ...rule, legacyOffset: 1000 }, { dungeon: { maxStamina: "240" } } as any)!.value,
    1,
    "offset larger than the maximum clamps to 1",
  );
  const channelRule = legacyToReminder("99", { uid: "1", roleId: "1", serverId: "1", name: "n" }, { ...legacyDm, notify_method: "channel", channelId: "555" })!;
  assert.deepEqual([channelRule.notify_method, channelRule.channelId, channelRule.guildId], ["channel", "555", undefined]);
  assert.equal(
    legacyToReminder("99", { uid: "1", roleId: "1", serverId: "1", name: "n" }, { stamina_notify: false, mission_notify: false }),
    null,
    "nothing switched on: no rule",
  );
  const defaulted = legacyToReminder("99", { uid: "1", roleId: "1", serverId: "1", name: "n" }, { stamina_notify: true })!;
  assert.equal(defaulted.legacyOffset, 10, "the old default distance");
  assert.equal(defaulted.daily, false);

  // ---- migration over the recorded monitorConfig shape
  await withDb(async (db) => {
    const accounts: Record<string, any[]> = {
      "100": [account("1001", ["7", "2", "Primary"], ["8", "2", "Alt"])],
      "200": [account("2001", ["9", "3", "Solo"]), account("2002", ["10", "3", "Second acc"])],
      "300": [], // linked nothing any more
    };
    await db.set("monitorConfig", {
      "100": { stamina_notify: true, stamina_offset: 30, mission_notify: false, notify_method: "dm", channelId: "1" },
      "200": { stamina_notify: false, mission_notify: true, notify_method: "channel", channelId: "777" },
      "300": { stamina_notify: true, stamina_offset: 10, mission_notify: true, notify_method: "dm" },
      "400": { stamina_notify: false, mission_notify: false },
      "bad id": { stamina_notify: true },
    });
    let lookups = 0;
    const getAccounts = async (userId: string) => {
      lookups++;
      if (userId === "400") throw new Error("must not even be asked");
      return accounts[userId] || [];
    };
    const r = await migrateLegacyMonitorConfig(db, getAccounts);
    assert.deepEqual(r, { users: 2, created: 3, skipped: false });
    const k1 = await db.get<ReminderConfig>("reminder.v2.100.1001.2.7");
    assert.equal(k1!.roleId, "7", "only the first (primary) role of the account");
    assert.equal(await db.get("reminder.v2.100.1001.2.8"), null);
    assert.equal(k1!.legacyOffset, 30);
    assert.equal(k1!.daily, false);
    assert.ok(await db.get("reminder.v2.200.2001.3.9"));
    assert.ok(await db.get("reminder.v2.200.2002.3.10"), "one rule per account");
    assert.equal((await db.get<any>("monitorConfig"))["100"].stamina_offset, 30, "legacy map is kept");
    assert.ok(await db.get(REMINDER_MIGRATION_MARKER));

    // idempotent; and a rule the user later deleted is not resurrected
    const lookupsBefore = lookups;
    await db.delete("reminder.v2.100.1001.2.7");
    assert.deepEqual(await migrateLegacyMonitorConfig(db, getAccounts), { users: 0, created: 0, skipped: true });
    assert.equal(lookups, lookupsBefore);
    assert.equal(await db.get("reminder.v2.100.1001.2.7"), null);
  });

  await withDb(async (db) => {
    // never overwrites a rule the user already saved (even if the marker is missing)
    await db.set("monitorConfig", { "100": { stamina_notify: true, stamina_offset: 5 } });
    const saved = { version: 2, revision: "mine", sanity: "time", value: 45 };
    await db.set("reminder.v2.100.1001.2.7", saved);
    const r = await migrateLegacyMonitorConfig(db, async () => [account("1001", ["7", "2", "R"])]);
    assert.equal(r.created, 0);
    assert.deepEqual(await db.get("reminder.v2.100.1001.2.7"), saved);
    // no monitorConfig at all: still completes and records the marker
    await withDb(async (db2) => {
      assert.deepEqual(await migrateLegacyMonitorConfig(db2, async () => []), { users: 0, created: 0, skipped: false });
    });
  });

  // ---- per-pass memoization: one load per key, failures are shared, keys are independent
  {
    const pass = createPassCache();
    let loads = 0;
    const load = (v: string) => async () => {
      loads++;
      return v;
    };
    assert.equal(await pass.get("a", load("A")), "A");
    assert.equal(await pass.get("a", load("A2")), "A");
    assert.equal(await pass.get("b", load("B")), "B");
    assert.equal(loads, 2);
    const results = await Promise.all([pass.get("c", load("C")), pass.get("c", load("C")), pass.get("c", load("C"))]);
    assert.deepEqual(results, ["C", "C", "C"]);
    assert.equal(loads, 3, "concurrent callers share one in-flight load");
    let failures = 0;
    const failing = async () => {
      failures++;
      throw new Error("x");
    };
    await assert.rejects(pass.get("f", failing));
    await assert.rejects(pass.get("f", failing));
    assert.equal(failures, 1);
    assert.equal(pass.size(), 4);
  }

  console.log("reminderMigration tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
