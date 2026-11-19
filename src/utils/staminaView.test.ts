import assert from "node:assert/strict";
import { buildStaminaView, formatDuration, staminaMessageText } from "./staminaView";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const sec = (ms: number) => String(Math.floor(ms / 1000));
const detail = (over: any = {}): any => ({
  base: { name: "Tester", roleId: "123", serverName: "Asia", level: 60, avatarUrl: "https://x/a.png" },
  dungeon: { curStamina: "120", maxStamina: "240", maxTs: sec(NOW + 3 * 3600_000) },
  dailyMission: { dailyActivation: 60, maxDailyActivation: 100 },
  weeklyMission: { score: 1200, total: 2000 },
  bpSystem: { curLevel: 12, maxLevel: 60 },
  ...over,
});

// Recovering: remaining and fullAt come from maxTs, not from a guessed rate.
{
  const v = buildStaminaView(detail(), NOW);
  assert.equal(v.sanity?.state, "recovering");
  assert.equal(v.sanity?.cur, 120);
  assert.equal(v.sanity?.max, 240);
  assert.equal(v.sanity?.ratio, 0.5);
  assert.equal(v.sanity?.remainingMs, 3 * 3600_000);
  assert.equal(v.sanity?.fullAtMs, NOW + 3 * 3600_000);
  assert.deepEqual(v.daily, { cur: 60, max: 100, ratio: 0.6 });
  assert.deepEqual(v.weekly, { cur: 1200, max: 2000, ratio: 0.6 });
  assert.deepEqual(v.pass, { cur: 12, max: 60, ratio: 0.2 });
  assert.equal(v.header.name, "Tester");
  assert.equal(v.header.level, 60);
  assert.equal(v.hasData, true);
}

// Already full.
{
  const v = buildStaminaView(detail({ dungeon: { curStamina: "240", maxStamina: "240", maxTs: "0" } }), NOW);
  assert.equal(v.sanity?.state, "full");
  assert.equal(v.sanity?.remainingMs, 0);
  assert.equal(v.sanity?.fullAtMs, undefined);
  assert.equal(v.sanity?.ratio, 1);
}

// Overflow stays visible (cur above max) but the bar is clamped.
{
  const v = buildStaminaView(detail({ dungeon: { curStamina: "300", maxStamina: "240", maxTs: "0" } }), NOW);
  assert.equal(v.sanity?.state, "full");
  assert.equal(v.sanity?.cur, 300);
  assert.equal(v.sanity?.ratio, 1);
}

// maxTs in the past while cur < max: the snapshot is stale, so it is full now.
{
  const v = buildStaminaView(detail({ dungeon: { curStamina: "100", maxStamina: "240", maxTs: sec(NOW - 60_000) } }), NOW);
  assert.equal(v.sanity?.state, "full");
  assert.equal(v.sanity?.cur, 240);
  assert.equal(v.sanity?.remainingMs, 0);
}

// cur < max and no usable maxTs: unknown, never a made-up time.
for (const maxTs of ["0", "", undefined, "abc"]) {
  const v = buildStaminaView(detail({ dungeon: { curStamina: "100", maxStamina: "240", maxTs } }), NOW);
  assert.equal(v.sanity?.state, "unknown");
  assert.equal(v.sanity?.remainingMs, undefined);
  assert.equal(v.sanity?.fullAtMs, undefined);
}

// Missing optional blocks are omitted, not zero.
{
  const v = buildStaminaView(detail({ weeklyMission: undefined, bpSystem: undefined, dailyMission: undefined }), NOW);
  assert.equal(v.weekly, undefined);
  assert.equal(v.pass, undefined);
  assert.equal(v.daily, undefined);
  assert.ok(v.sanity);
  assert.equal(v.hasData, true);
}

// Zero totals and garbage are omitted too.
{
  const v = buildStaminaView(detail({ dailyMission: { dailyActivation: 0, maxDailyActivation: 0 }, weeklyMission: { score: "x", total: null }, dungeon: { curStamina: "", maxStamina: "" } }), NOW);
  assert.equal(v.daily, undefined);
  assert.equal(v.weekly, undefined);
  assert.equal(v.sanity, undefined);
  assert.ok(v.pass);
}

// A genuine 0 progress with a real total stays (0 is data, a missing block is not).
assert.deepEqual(buildStaminaView(detail({ dailyMission: { dailyActivation: 0, maxDailyActivation: 100 } }), NOW).daily, { cur: 0, max: 100, ratio: 0 });

// Nothing at all.
{
  const v = buildStaminaView({}, NOW);
  assert.equal(v.hasData, false);
  assert.equal(buildStaminaView(null, NOW).hasData, false);
  assert.equal(v.header.name, "");
}

assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000, "h", "m"), "3h 5m");
assert.equal(formatDuration(59_000, "h", "m"), "1m");
assert.equal(formatDuration(0, "h", "m"), "0m");
assert.equal(formatDuration(2 * 3600_000, "小時", "分鐘"), "2小時 0分鐘");

// Message line: Discord timestamp markup, per state.
{
  const fake = (key: string, o: any = {}) => `${key}|${o.cur_max ?? ""}|${o.clock ?? ""}|${o.relative ?? ""}`;
  const ts = Math.floor((NOW + 3 * 3600_000) / 1000);
  assert.equal(staminaMessageText(buildStaminaView(detail(), NOW), fake), `stamina_MsgRecovering|120/240|<t:${ts}:t>|<t:${ts}:R>`);
  assert.equal(staminaMessageText(buildStaminaView(detail({ dungeon: { curStamina: "240", maxStamina: "240" } }), NOW), fake), "stamina_MsgFull|240/240||");
  assert.equal(staminaMessageText(buildStaminaView(detail({ dungeon: { curStamina: "10", maxStamina: "240" } }), NOW), fake), "stamina_MsgUnknown|10/240||");
  assert.equal(staminaMessageText(buildStaminaView({}, NOW), fake), "");
}

console.log("staminaView tests passed");
