import assert from "node:assert/strict";
import {
  AutoDailyState,
  classifyAttendance,
  EXPIRED_CONFIRM_MS,
  isExpiryConfirmed,
  isRolloverCatchUp,
  isTokenExpiredError,
  isTransientError,
  MAX_AUTO_DAILY_ATTEMPTS,
  MAX_EXPIRED_DMS_PER_TICK,
  shouldStartAnotherUser,
  TICK_BUDGET_MS,
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
    "23:00 user failed late: yesterday is unfinished, one catch-up attempt for the new day at once",
    "2026-11-20 00:00",
    23,
    st({ attempts: 1, nextAttemptAt: tpe("2026-11-20 00:00") }),
    "run",
  ],
  // day rollover catch-up
  ["hour-23 user not reached yesterday (state two days old) runs at 00:xx", "2026-11-20 00:10", 23, st({ date: "2026-11-18", status: "done" }), "run"],
  ["hour-23 user done yesterday waits for 23:00 today", "2026-11-20 00:10", 23, st({ date: "2026-11-19", status: "done" }), "skip"],
  ["hour-23 user failed yesterday (final) waits too", "2026-11-20 00:10", 23, st({ date: "2026-11-19", status: "failed" }), "skip"],
  ["hour-23 user done yesterday runs at 23:00 today", "2026-11-20 23:00", 23, st({ date: "2026-11-19", status: "done" }), "run"],
  ["no state at all is not a catch-up (new user / first tick after rollout)", "2026-11-20 00:10", 23, null, "skip"],
  ["catch-up window is the first hours only", "2026-11-20 03:00", 23, st({ date: "2026-11-18", status: "done" }), "skip"],
  ["last hour of the window", "2026-11-20 02:59", 23, st({ date: "2026-11-18", status: "done" }), "run"],
  [
    "after a catch-up that failed, the normal hour gate applies (next at 23:00)",
    "2026-11-20 01:00",
    23,
    st({ date: "2026-11-20", attempts: 1, nextAttemptAt: tpe("2026-11-20 01:00") }),
    "skip",
  ],
  [
    "...and at 23:00 it retries as attempt 2",
    "2026-11-20 23:00",
    23,
    st({ date: "2026-11-20", attempts: 1, nextAttemptAt: tpe("2026-11-20 01:00") }),
    "run",
  ],
  ["a catch-up that succeeded counts as done: no second sign at 23:00", "2026-11-20 23:00", 23, st({ date: "2026-11-20", status: "done" }), "skip"],
  ["any hour: unfinished yesterday runs at 00:xx", "2026-11-20 00:10", 13, st({ date: "2026-11-19", status: "retry" }), "run"],
  ["hour 0 user is not affected", "2026-11-20 00:10", 0, st({ date: "2026-11-19", status: "done" }), "run"],
];
for (const [name, now, time, state, expected] of cases) {
  assert.equal(planAutoDaily(tpe(now), { time }, state), expected, name);
}

assert.equal(isRolloverCatchUp(tpe("2026-11-20 00:10"), st({ date: "2026-11-19", status: "retry" })), true);
assert.equal(isRolloverCatchUp(tpe("2026-11-20 00:10"), undefined), false);

// constants named by the requirements
assert.equal(MAX_EXPIRED_DMS_PER_TICK, 40);
assert.equal(EXPIRED_CONFIRM_MS, 30 * 60 * 1000);
assert.equal(TICK_BUDGET_MS, 50 * 60 * 1000);

// expiry confirmation needs a first sighting at least 30 minutes old
assert.equal(isExpiryConfirmed(undefined, tpe("2026-11-19 14:00")), false);
assert.equal(isExpiryConfirmed(tpe("2026-11-19 13:31"), tpe("2026-11-19 14:00")), false);
assert.equal(isExpiryConfirmed(tpe("2026-11-19 13:30"), tpe("2026-11-19 14:00")), true);

// tick budget
assert.equal(shouldStartAnotherUser(tpe("2026-11-19 13:00"), tpe("2026-11-19 13:49")), true);
assert.equal(shouldStartAnotherUser(tpe("2026-11-19 13:00"), tpe("2026-11-19 13:50")), false);

// transient vs permanent thrown errors
for (const e of [
  Object.assign(new Error("x"), { code: "ECONNABORTED" }),
  Object.assign(new Error("x"), { code: "ECONNRESET" }),
  new Error("timeout of 15000ms exceeded"),
  { response: { status: 503 } },
  { response: { status: 429 } },
])
  assert.equal(isTransientError(e), true, JSON.stringify(e));
for (const e of [new Error("boom"), { response: { status: 400 } }, { response: { status: 403 } }, null, undefined])
  assert.equal(isTransientError(e), false);

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

// permanent errors are not retried
assert.deepEqual(
  nextAutoDailyState("2026-11-19", now, 1, { ...zero, permanentError: 1 }, "HTTP 400"),
  { date: "2026-11-19", status: "failed", attempts: 1, lastError: "HTTP 400" },
);
assert.equal(
  nextAutoDailyState("2026-11-19", now, 1, { ...zero, signed: 1, permanentError: 1 }, "x").status,
  "failed",
  "a permanent error with nothing left to retry ends the day",
);
assert.equal(
  nextAutoDailyState("2026-11-19", now, 1, { ...zero, permanentError: 1, error: 1 }, "x").status,
  "retry",
  "a transient error next to a permanent one still gets its retry",
);

// a pending dead login is re-checked after >= 30 minutes; a transient error at the next hour
{
  const seen = { a1: tpe("2026-11-19 13:10") };
  const p = nextAutoDailyState("2026-11-19", tpe("2026-11-19 13:10"), 1, { ...zero, tokenExpiredPending: 1 }, undefined, seen);
  assert.equal(p.nextAttemptAt, tpe("2026-11-19 14:00"));
  assert.deepEqual(p.expiredSeen, seen);
  assert.equal(p.expiredSeenAt, tpe("2026-11-19 13:10"));
  const late = nextAutoDailyState("2026-11-19", tpe("2026-11-19 13:45"), 1, { ...zero, tokenExpiredPending: 1 }, undefined, { a1: tpe("2026-11-19 13:45") });
  assert.equal(late.nextAttemptAt, tpe("2026-11-19 15:00"), "never closer than 30 minutes to the first sighting");
  const mixed = nextAutoDailyState("2026-11-19", tpe("2026-11-19 13:45"), 1, { ...zero, tokenExpiredPending: 1, error: 1 }, "x", { a1: tpe("2026-11-19 13:45") });
  assert.equal(mixed.nextAttemptAt, tpe("2026-11-19 14:00"), "a transient error does not wait");
  assert.equal(nextAutoDailyState("2026-11-19", now, 1, { ...zero, error: 1 }, "x").expiredSeen, undefined);
  assert.equal(
    nextAutoDailyState("2026-11-19", now, 2, { ...zero, tokenExpiredConfirmed: 1 }, undefined, seen).expiredSeen,
    undefined,
    "a finished day keeps no sighting",
  );
}

console.log("autoDailyPlan checks passed");
