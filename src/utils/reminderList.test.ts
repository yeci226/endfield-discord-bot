import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";
import { createTranslator } from "./i18n";
import {
  LIST_PAGE_SIZE,
  buildReminderListPayload,
  clampPage,
  deleteRule,
  keyFromSuffix,
  nextDailyAt,
  reminderList,
  reminderListComponent,
  ruleStatus,
  ruleSuffix,
  toggleRule,
} from "./reminderList";
import { ReminderConfig, reminderKey, reminderStateKey } from "./reminders";

const accountUtils = require("./accountUtils");

const json = (v: any) => JSON.parse(JSON.stringify(v));
const NOW = Date.parse("2026-11-19T10:00:00Z");

const rule = (userId: string, n: number, extra: Partial<ReminderConfig> = {}): ReminderConfig => ({
  version: 2,
  revision: `rev${userId}-${n}`,
  userId,
  uid: String(1000 + n),
  roleId: String(n),
  serverId: "2",
  name: `Role ${String(n).padStart(2, "0")}`,
  enabled: true,
  mention: false,
  notify_method: "dm",
  sanity: "time",
  value: 60,
  daily: true,
  dailyHours: 3,
  resetOffset: 8,
  ...extra,
});

/** All components of the (single) container, flattened to {type,id,disabled,options?}. */
function flatten(payload: any) {
  const container = json(payload).components[0];
  const out: any[] = [];
  const walk = (c: any) => {
    out.push(c);
    (c.components || []).forEach(walk);
  };
  container.components.forEach(walk);
  return out;
}
const buttons = (p: any) => flatten(p).filter((c) => c.type === 2);
const select = (p: any) => flatten(p).find((c) => c.type === 3);
const textOf = (p: any) => flatten(p).filter((c) => c.type === 10).map((c) => c.content).join("\n");

async function main() {
  const tr = createTranslator("en");
  const tw = createTranslator("tw");

  // ---- status & next fire time
  {
    const c = rule("1", 1);
    assert.equal(ruleStatus(c, null, NOW), "active");
    assert.equal(ruleStatus({ ...c, enabled: false }, null, NOW), "paused");
    assert.equal(ruleStatus(c, { revision: c.revision, disabledReason: "x" }, NOW), "system");
    assert.equal(ruleStatus(c, { revision: "old", disabledReason: "x" }, NOW), "active", "stale state is ignored");
    assert.equal(ruleStatus(c, { revision: c.revision, retryAt: NOW + 1000 }, NOW), "retry");
    assert.equal(ruleStatus(c, { revision: c.revision, retryAt: NOW - 1000 }, NOW), "active");

    // reset is 04:00 UTC+8 = 20:00Z; 3h before = 17:00Z
    const at = nextDailyAt(c, null, NOW)!;
    assert.equal(new Date(at).toISOString(), "2026-11-19T17:00:00.000Z");
    // already sent for this cycle -> the next day's window
    const reset = Date.parse("2026-11-19T20:00:00Z");
    assert.equal(new Date(nextDailyAt(c, { revision: c.revision, dailyCycle: reset }, NOW)!).toISOString(), "2026-11-20T17:00:00.000Z");
    // window already open -> now
    assert.equal(nextDailyAt(c, null, Date.parse("2026-11-19T18:30:00Z")), Date.parse("2026-11-19T18:30:00Z"));
    assert.equal(nextDailyAt({ ...c, daily: false }, null, NOW), null);
    assert.equal(nextDailyAt({ ...c, resetOffset: undefined }, null, NOW), null);
  }

  // ---- paging helpers
  assert.equal(clampPage(5, 3), 0);
  assert.equal(clampPage(-2, 30), 0);
  assert.equal(clampPage(99, 30), 2);
  assert.equal(clampPage(NaN, 30), 0);
  assert.equal(keyFromSuffix("9", "1.2.3"), "reminder.v2.9.1.2.3");
  assert.equal(keyFromSuffix("9", "1.2.3.4"), null);
  assert.equal(keyFromSuffix("9", "../x"), null);

  // ---- rendering
  {
    const rules = Array.from({ length: 23 }, (_, i) => ({ config: rule("1", i + 1), state: null, accountName: "Acc" }));
    const p0 = buildReminderListPayload({ rules, page: 0, now: NOW }, tr);
    assert.equal(json(p0).flags, 1 << 15);
    const sel0 = select(p0);
    assert.equal(sel0.options.length, LIST_PAGE_SIZE);
    assert.equal(sel0.options[0].value, "1001.2.1");
    assert.equal(sel0.custom_id, "reminder:list:sel:0");
    assert.match(textOf(p0), /Page 1 \/ 3/);
    assert.match(textOf(p0), /<t:\d+:R>/, "next fire time is shown as a Discord timestamp");
    let bs = buttons(p0);
    const byLabel = (l: string) => bs.find((b) => b.label === l);
    assert.equal(byLabel("Pause").disabled, true, "nothing selected yet");
    assert.equal(byLabel("Delete").disabled, true);
    assert.equal(byLabel("Close").custom_id, "reminder:list:close");
    assert.equal(byLabel("Previous").disabled, true);
    assert.equal(byLabel("Next").custom_id, "reminder:list:pg:1");
    assert.equal(byLabel("Next").disabled, false);

    // last page, partially filled; selection enables the buttons with the rule encoded
    const p2 = buildReminderListPayload({ rules, page: 2, selected: "1021.2.21", now: NOW }, tr);
    assert.equal(select(p2).options.length, 3);
    bs = buttons(p2);
    assert.equal(bs.find((b) => b.label === "Pause").custom_id, "reminder:list:toggle:2:1021.2.21");
    assert.equal(bs.find((b) => b.label === "Pause").disabled, false);
    assert.equal(bs.find((b) => b.label === "Next").disabled, true);
    assert.ok(select(p2).options.find((o: any) => o.value === "1021.2.21").default);
    // out-of-range page is clamped, not an error
    assert.equal(select(buildReminderListPayload({ rules, page: 50, now: NOW }, tr)).custom_id, "reminder:list:sel:2");

    // paused rule offers Resume; system-disabled too
    const paused = [{ config: rule("1", 1, { enabled: false }), state: null, accountName: "A" }];
    const pp = buildReminderListPayload({ rules: paused, page: 0, selected: "1001.2.1", now: NOW }, tr);
    assert.ok(buttons(pp).some((b) => b.label === "Resume" && !b.disabled));
    assert.match(textOf(pp), /Paused/);
    const sys = [{ config: rule("1", 1), state: { revision: "rev1-1", disabledReason: "x" }, accountName: "A" }];
    assert.ok(buttons(buildReminderListPayload({ rules: sys, page: 0, selected: "1001.2.1", now: NOW }, tr)).some((b) => b.label === "Resume"));

    // delete asks for confirmation; every screen can be closed
    const pc = buildReminderListPayload({ rules, page: 0, selected: "1001.2.1", confirmDelete: true, now: NOW }, tr);
    assert.match(textOf(pc), /This cannot be undone/);
    assert.ok(buttons(pc).some((b) => b.custom_id === "reminder:list:delok:0:1001.2.1"));
    assert.ok(buttons(pc).some((b) => b.custom_id === "reminder:list:close"));
    assert.equal(select(pc), undefined);

    // empty list: explanation + close
    const pe = buildReminderListPayload({ rules: [], page: 0, now: NOW }, tr);
    assert.match(textOf(pe), /\/reminder setup/);
    assert.deepEqual(buttons(pe).map((b) => b.custom_id), ["reminder:list:close"]);

    // icons for type, channel target, localized text
    const mixed = [
      { config: rule("1", 1, { daily: false, notify_method: "channel", channelId: "555" }), state: null, accountName: "A" },
      { config: rule("1", 2, { sanity: "off" }), state: null, accountName: "A" },
    ];
    const pm = buildReminderListPayload({ rules: mixed, page: 0, now: NOW }, tw);
    const txt = textOf(pm);
    assert.match(txt, /⚡ \*\*Role 01\*\*/);
    assert.match(txt, /📅 \*\*Role 02\*\*/);
    assert.match(txt, /<#555>/);
    assert.match(txt, /提醒規則/);

    // customIds fit Discord's 100 character limit even for the longest ids
    const long = rule("1", 1, { uid: "9".repeat(20), roleId: "8".repeat(20), serverId: "7".repeat(10) });
    const pl = buildReminderListPayload({ rules: [{ config: long, state: null, accountName: "A" }], page: 99, selected: ruleSuffix(long), confirmDelete: true, now: NOW }, tr);
    for (const b of buttons(pl)) assert.ok(b.custom_id.length <= 100, b.custom_id);
  }

  // ---- data operations
  const db = new CustomDatabase(":memory:");
  const client: any = { db };
  {
    const mine = rule("100", 1);
    const theirs = rule("200", 7);
    await db.set(reminderKey(mine), mine);
    await db.set(reminderStateKey(mine), { revision: mine.revision, sanitySent: true });
    await db.set(reminderKey(theirs), theirs);

    assert.equal(toggleRule(client, "100", ruleSuffix(mine)), false, "enabled -> paused");
    let stored = (await db.get<ReminderConfig>(reminderKey(mine)))!;
    assert.equal(stored.enabled, false);
    assert.notEqual(stored.revision, mine.revision, "revision bump invalidates the old state");
    assert.equal(toggleRule(client, "100", ruleSuffix(mine)), true, "paused -> enabled");
    assert.equal(toggleRule(client, "100", "1.2.3"), null, "unknown rule");
    assert.equal(toggleRule(client, "100", "nonsense"), null);
    // a system-disabled rule is re-armed (stays enabled) instead of being paused
    stored = (await db.get<ReminderConfig>(reminderKey(mine)))!;
    await db.set(reminderStateKey(stored), { revision: stored.revision, disabledReason: "dest gone" });
    const revBefore = stored.revision;
    assert.equal(toggleRule(client, "100", ruleSuffix(mine)), true);
    stored = (await db.get<ReminderConfig>(reminderKey(mine)))!;
    assert.equal(stored.enabled, true);
    assert.notEqual(stored.revision, revBefore);

    // the invoking user's id is part of the key: another user's rule is unreachable
    assert.equal(toggleRule(client, "100", ruleSuffix(theirs)), null, "a rule that belongs to someone else is not found");
    assert.equal(deleteRule(client, "100", ruleSuffix(theirs)), false);
    assert.equal((await db.get<ReminderConfig>(reminderKey(theirs)))!.enabled, true);

    // delete removes the rule and its state
    await db.set(reminderStateKey(stored), { revision: stored.revision });
    assert.equal(deleteRule(client, "100", ruleSuffix(mine)), true);
    assert.equal(await db.get(reminderKey(mine)), null);
    assert.equal(await db.get(reminderStateKey(stored)), null);
    assert.equal(deleteRule(client, "100", ruleSuffix(mine)), false);
  }

  // ---- interaction flow
  {
    const original = accountUtils.getAccounts;
    accountUtils.getAccounts = async () => [{ info: { id: "1001", nickname: "MyAcc" }, roles: [{ gameId: 3, roles: [{ roleId: "1", serverId: "2", nickname: "R" }] }] }];
    try {
      const r1 = rule("300", 1);
      const r2 = rule("300", 2);
      await db.set(reminderKey(r1), r1);
      await db.set(reminderKey(r2), r2);
      const calls: string[] = [];
      let screen: any;
      const make = (customId: string | undefined, extra: any = {}) => ({
        user: { id: "300" },
        customId,
        values: [] as string[],
        deferReply: async () => void calls.push("deferReply"),
        deferUpdate: async () => void calls.push("deferUpdate"),
        editReply: async (p: any) => {
          calls.push("editReply");
          screen = p;
        },
        followUp: async (p: any) => void calls.push("followUp:" + p.content),
        deleteReply: async () => void calls.push("deleteReply"),
        ...extra,
      });

      await reminderList(client, make(undefined), tr);
      assert.deepEqual(calls, ["deferReply", "editReply"], "acknowledged before any work");
      assert.equal(select(screen).options.length, 2);
      assert.match(textOf(screen), /MyAcc/, "account name comes from the linked account");

      calls.length = 0;
      await reminderListComponent(client, make("reminder:list:sel:0", { values: ["1002.2.2"] }), tr);
      assert.ok(buttons(screen).find((b) => b.label === "Pause" && !b.disabled));
      assert.equal(calls[0], "deferUpdate");

      calls.length = 0;
      await reminderListComponent(client, make("reminder:list:toggle:0:1002.2.2"), tr);
      assert.equal((await db.get<ReminderConfig>(reminderKey(r2)))!.enabled, false);
      assert.ok(calls.includes("followUp:Reminder paused."));
      assert.ok(buttons(screen).find((b) => b.label === "Resume" && !b.disabled));

      calls.length = 0;
      await reminderListComponent(client, make("reminder:list:del:0:1002.2.2"), tr);
      assert.ok(await db.get(reminderKey(r2)), "asking to delete does not delete");
      assert.match(textOf(screen), /cannot be undone/);
      await reminderListComponent(client, make("reminder:list:delok:0:1002.2.2"), tr);
      assert.equal(await db.get(reminderKey(r2)), null);
      assert.equal(select(screen).options.length, 1);
      assert.ok(calls.includes("followUp:Reminder deleted."));
      // a stale button for an already deleted rule reports it instead of failing
      calls.length = 0;
      await reminderListComponent(client, make("reminder:list:delok:0:1002.2.2"), tr);
      assert.ok(calls.includes("followUp:That rule no longer exists; it may have been deleted."));

      calls.length = 0;
      await reminderListComponent(client, make("reminder:list:close"), tr);
      assert.deepEqual(calls, ["deferUpdate", "deleteReply"]);
    } finally {
      accountUtils.getAccounts = original;
    }
  }

  console.log("reminderList tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
