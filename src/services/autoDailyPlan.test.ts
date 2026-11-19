import assert from "node:assert/strict";
import {
  AutoDailyState,
  classifyAttendance,
  isTokenExpiredError,
  MAX_AUTO_DAILY_ATTEMPTS,
  nextAutoDailyState,
  nextHourStart,
  planAutoDaily,
  taipeiDate,
  taipeiHour,
} from "./autoDailyPlan";

// Taipei helper: "YYYY-MM-DD HH:mm" in UTC+8 -> epoch ms
const tpe = (s: string) => Date.parse(s.replace(" ", "T") + ":00+08:00");

assert.equal(taipeiDate(tpe("2026-11-19 00:00")), "2026-11-19");
assert.equal(taipeiDate(tpe("2026-11-19 23:59")), "2026-11-19");
assert.equal(taipeiHour(tpe("2026-11-19 07:30")), 7);
assert.equal(taipeiHour(Date.parse("2026-11-18T16:00:00Z")), 0); // = 00:00 next day in Taipei
assert.equal(taipeiDate(Date.parse("2026-11-18T16:00:00Z")), "2026-11-19");
assert.equal(nextHourStart(tpe("2026-11-19 13:10")), tpe("2026-11-19 14:00"));
assert.equal(nextHourStart(tpe("2026-11-19 23:59")), tpe("2026-11-20 00:00"));

const st = (p: Partial<AutoDailyState>): AutoDailyState => ({
  date: "2026-11-19",
  status: "retry",
  attempts: 1,
  ...p,
});

const cases: Array<[string, string, number, AutoDailyState | null, "run" | "skip"]> = [
  ["before the configured hour", "2026-11-19 12:59", 13, null, "skip"],
  ["configured hour, no state", "2026-11-19 13:00", 13, null, "run"],
  ["done today", "2026-11-19 13:05", 13, st({ status: "done" }), "skip"],
  ["done today, later hour", "2026-11-19 20:00", 13, st({ status: "done" }), "skip"],
  [
    "retry due",
    "2026-11-19 14:00",
    13,
    st({ attempts: 1, nextAttemptAt: tpe("2026-11-19 14:00") }),
    "run",
  ],
  [
    "retry not due yet",
    "2026-11-19 13:40",
    13,
    st({ attempts: 1, nextAttemptAt: tpe("2026-11-19 14:00") }),
    "skip",
  ],
  [
    "attempts exhausted",
    "2026-11-19 20:00",
    13,
    st({ attempts: MAX_AUTO_DAILY_ATTEMPTS, nextAttemptAt: tpe("2026-11-19 14:00") }),
    "skip",
  ],
  [
    "last allowed attempt",
    "2026-11-19 20:00",
    13,
    st({ attempts: MAX_AUTO_DAILY_ATTEMPTS - 1, nextAttemptAt: tpe("2026-11-19 19:00") }),
    "run",
  ],
  ["failed (dead token) is not retried", "2026-11-19 20:00", 13, st({ status: "failed" }), "skip"],
  // day rollover
  [
    "yesterday done, new day, hour reached",
    "2026-11-20 13:00",
    13,
    st({ date: "2026-11-19", status: "done" }),
    "run",
  ],
  [
    "yesterday done, new day, hour not reached",
    "2026-11-20 01:00",
    13,
    st({ date: "2026-11-19", status: "done" }),
    "skip",
  ],
  [
    "yesterday exhausted, new day starts fresh",
    "2026-11-20 13:00",
    13,
    st({ date: "2026-11-19", attempts: 6, status: "failed" }),
    "run",
  ],
  // bot was down when the hour passed: catch up as soon as it is back
  ["hour passed while the bot was down", "2026-11-19 17:20", 13, null, "run"],
  ["midnight user, first check of the day", "2026-11-19 00:00", 0, null, "run"],
  // a 23:00 user whose attempt failed at 23:xx has no more hours today; the next day starts fresh
  [
    "23:00 user failed late, still the same day",
    "2026-11-19 23:30",
    23,
    st({ attempts: 1, nextAttemptAt: tpe("2026-11-20 00:00") }),
    "skip",
  ],
  [
    "23:00 user failed late, after midnight the new day takes over (not a retry of yesterday)",
    "2026-11-20 00:00",
    23,
    st({ attempts: 1, nextAttemptAt: tpe("2026-11-20 00:00") }),
    "skip", // hour 0 < 23: nothing until 23:00 on the new day
  ],
];
for (const [name, now, time, state, expected] of cases) {
  assert.equal(planAutoDaily(tpe(now), { time }, state), expected, name);
}

// classifyAttendance
assert.equal(classifyAttendance({ signedNow: true, hasToday: true }), "signed");
assert.equal(classifyAttendance({ hasToday: true }), "already");
assert.equal(classifyAttendance({ error: true, message: "boom" }), "error");
assert.equal(
  classifyAttendance({ error: true, errorKind: "token_expired" }),
  "token_expired",
);
assert.equal(classifyAttendance({ error: true, errorKind: "error" }), "error");
assert.equal(classifyAttendance(null), "error");
assert.equal(classifyAttendance({}), "error", "no success signal is never 'already'");
assert.ok(isTokenExpiredError(Object.assign(new Error("x"), { code: 10000 })));
assert.ok(isTokenExpiredError(new Error("TokenExpired")));
assert.ok(!isTokenExpiredError(new Error("boom")));
assert.ok(!isTokenExpiredError(null));

// nextAutoDailyState
const now = tpe("2026-11-19 13:10");
const zero = {
  signed: 0,
  already: 0,
  error: 0,
  tokenExpiredPending: 0,
  tokenExpiredConfirmed: 0,
};
assert.deepEqual(nextAutoDailyState("2026-11-19", now, 1, { ...zero, signed: 2 }), {
  date: "2026-11-19",
  status: "done",
  attempts: 1,
});
assert.equal(nextAutoDailyState("2026-11-19", now, 1, zero).status, "done", "nothing to do is done");
assert.deepEqual(
  nextAutoDailyState("2026-11-19", now, 2, { ...zero, signed: 1, error: 1 }, "HTTP 500"),
  {
    date: "2026-11-19",
    status: "retry",
    attempts: 2,
    lastError: "HTTP 500",
    nextAttemptAt: tpe("2026-11-19 14:00"),
  },
);
assert.equal(
  nextAutoDailyState("2026-11-19", now, MAX_AUTO_DAILY_ATTEMPTS, { ...zero, error: 1 }, "x")
    .status,
  "failed",
);
const pending = nextAutoDailyState("2026-11-19", now, 1, { ...zero, tokenExpiredPending: 1 });
assert.equal(pending.status, "retry", "an unconfirmed dead token is re-checked next hour");
const confirmed = nextAutoDailyState("2026-11-19", now, 2, {
  ...zero,
  tokenExpiredConfirmed: 1,
});
assert.equal(confirmed.status, "failed", "a confirmed dead token is not retried today");
assert.equal(confirmed.lastError, "token_expired");
assert.equal(
  nextAutoDailyState("2026-11-19", now, 2, { ...zero, tokenExpiredConfirmed: 1, error: 1 }).status,
  "retry",
  "a real error alongside a dead token still retries",
);

console.log("autoDailyPlan checks passed");
