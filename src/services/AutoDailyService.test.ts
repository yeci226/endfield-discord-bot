process.env.ENCRYPTION_KEY = "ab".repeat(32); // test key (64 hex chars)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "../utils/Database";
import { patchAccount } from "../utils/accountData";
import { AutoDailyService } from "./AutoDailyService";
import { MAX_EXPIRED_DMS_PER_TICK, planAutoDaily, taipeiDate } from "./autoDailyPlan";

// The service calls these through its imports, so replacing the module properties works.
const accountUtils = require("../utils/accountUtils");
const attendanceUtils = require("../utils/attendanceUtils");
const skportApi = require("../utils/skportApi");
const originals = {
  ensureAccountBinding: accountUtils.ensureAccountBinding,
  processRoleAttendance: attendanceUtils.processRoleAttendance,
  getGamePlayerBinding: skportApi.getGamePlayerBinding,
  wasRefreshInconclusive: accountUtils.wasRefreshInconclusive,
};

let counter = 0;
function tempDb(): { db: CustomDatabase; cleanup: () => void } {
  const file = path.join(
    os.tmpdir(),
    `ef-autodaily-test-${process.pid}-${counter++}.sqlite`,
  );
  const db = new CustomDatabase(file);
  return {
    db,
    cleanup: () => {
      db.close();
      for (const s of ["", "-wal", "-shm"])
        fs.rmSync(file + s, { force: true });
    },
  };
}

function makeService(db: CustomDatabase, dmError?: () => any) {
  const sent: any[] = [];
  const service = new AutoDailyService({
    db,
    users: {
      fetch: async () => ({
        send: async (payload: any) => {
          const err = dmError?.();
          if (err) throw err;
          sent.push(payload);
        },
      }),
    },
  } as any);
  return { service, sent };
}

const config = (over: any = {}) => ({
  time: 0,
  auto_balance: false,
  notify: true,
  notify_method: "dm" as const,
  mention: true,
  game_scope: "both" as const,
  ...over,
});

const today = taipeiDate(Date.now());
const EF_ROLE = { roleId: "6600112233", serverId: "2", nickname: "Endmin", level: 30, serverName: "Asia" };
const storedAccounts = (db: CustomDatabase, userId: string) =>
  db.get<any[]>(`${userId}.accounts`);
/** A first "dead login" sighting of these account ids, `minutesAgo` minutes ago (today's retry state). */
async function seedSeen(db: CustomDatabase, userId: string, ids: string[], minutesAgo = 31) {
  const at = Date.now() - minutesAgo * 60 * 1000;
  await db.set(`autoDailyState.${userId}`, {
    date: today,
    status: "retry",
    attempts: 1,
    nextAttemptAt: 0,
    expiredSeen: Object.fromEntries(ids.map((id) => [id, at])),
    expiredSeenAt: at,
  });
}

async function main() {
  accountUtils.ensureAccountBinding = async () => {};
  skportApi.getGamePlayerBinding = async () => null;
  let calls: any[] = [];
  let attendance: (role: any, gameId: number, options?: any) => any = () => ({
    signedNow: true,
    hasToday: true,
    nickname: "n",
  });
  attendanceUtils.processRoleAttendance = async (
    role: any,
    gameId: number,
    _cookie: string,
    _lang: string,
    _cred: string,
    _salt: string,
    _claim: boolean,
    _tr: any,
    options: any,
  ) => {
    calls.push({ role, gameId });
    return attendance(role, gameId, options);
  };

  try {
    // --- confirmed dead token: one DM regardless of notify, never repeated ---------
    for (const notify of [false, true]) {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Expired account 1" }, invalid: true },
          { info: { id: "2", nickname: "Expired account 2" }, invalid: true },
        ]);
        await seedSeen(db, "99", ["1", "2"]); // seen dead 31 minutes ago: this attempt confirms
        const { service, sent } = makeService(db);
        await service.processUser("99", config({ notify }), 101);
        assert.equal(sent.length, 2, "one DM per dead account, and no duplicate error line");
        assert.ok(sent.every((p) => p.content.includes("/login")));
        assert.ok(sent[0].content.includes("Expired account 1") || sent[0].content.includes("Expired account 2"));
        const after = (await storedAccounts(db, "99"))!;
        assert.ok(after.every((a) => a.tokenExpiredNotified === true), "flag persisted");
        const state: any = await db.get("autoDailyState.99");
        assert.equal(state.status, "failed", "a confirmed dead token is not retried today");
        assert.equal(state.date, today);

        await service.processUser("99", config({ notify }), 101);
        assert.equal(sent.length, 2, "same hour: claimed slot sends nothing");
        await service.processUser("99", config({ notify }), 102);
        assert.equal(sent.length, 2, "a later run does not DM again: the flag is set");
      } finally {
        cleanup();
      }
    }

    // --- DM closed (50007): swallowed, flag still set ----------------------------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "A" }, invalid: true },
        ]);
        await seedSeen(db, "99", ["1"]);
        let attempts = 0;
        const { service, sent } = makeService(db, () => {
          attempts++;
          return Object.assign(new Error("Cannot send messages to this user"), {
            code: 50007,
          });
        });
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal(attempts, 1);
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, true);
        await service.processUser("99", config({ notify: false }), 102);
        assert.equal(attempts, 1, "no second attempt once the flag is set");
        assert.equal(sent.length, 0);
      } finally {
        cleanup();
      }
    }

    // --- DM failing for another reason leaves the flag unset (try again later) ----
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "A" }, invalid: true },
        ]);
        await seedSeen(db, "99", ["1"]);
        const { service } = makeService(db, () => new Error("network down"));
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, undefined);
      } finally {
        cleanup();
      }
    }

    // --- a stored `invalid` flag alone never confirms a dead login ----------------------
    // Needs a sighting of this run chain, then a later attempt >= 30 minutes after it.
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Flagged by another command" }, invalid: true },
        ]);
        const { service, sent } = makeService(db);
        const noon = Date.parse(`${today}T12:00:00+08:00`);
        let t = noon;
        service.now = () => t;

        await service.processUser("99", config({ notify: true }), 101);
        assert.equal(sent.length, 0, "first sighting: no DM, and no error line either");
        let s: any = await db.get("autoDailyState.99");
        assert.equal(s.status, "retry");
        assert.equal(s.attempts, 1);
        assert.deepEqual(s.expiredSeen, { "1": noon });
        assert.equal(s.expiredSeenAt, noon);
        assert.ok(s.nextAttemptAt >= noon + 30 * 60 * 1000, "never re-checked sooner than 30 minutes");
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, undefined);

        t = noon + 10 * 60 * 1000;
        await service.processUser("99", config({ notify: true }), 102);
        assert.equal(sent.length, 0, "10 minutes later is not enough");
        s = await db.get("autoDailyState.99");
        assert.equal(s.status, "retry");
        assert.equal(s.expiredSeen["1"], noon, "the first sighting time is kept");

        t = noon + 31 * 60 * 1000;
        await service.processUser("99", config({ notify: true }), 103);
        assert.equal(sent.length, 1, "seen dead again 31 minutes later: confirmed, one DM");
        assert.ok(sent[0].content.includes("/login"));
        s = await db.get("autoDailyState.99");
        assert.equal(s.status, "failed");
        assert.equal(s.expiredSeen, undefined);
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, true);
      } finally {
        cleanup();
      }
    }

    // --- recovery clears the sighting; a sighting is per account ------------------------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "A" }, invalid: true, roles: [{ gameId: 1, uid: "5", nickName: "x", roles: [] }] },
          { info: { id: "2", nickname: "B" }, invalid: true },
        ]);
        const noon = Date.parse(`${today}T12:00:00+08:00`);
        // A was seen dead 31 minutes ago; B has never been seen dead.
        await db.set("autoDailyState.99", {
          date: today,
          status: "retry",
          attempts: 1,
          nextAttemptAt: 0,
          expiredSeen: { "1": noon - 31 * 60 * 1000 },
          expiredSeenAt: noon - 31 * 60 * 1000,
        });
        const { service, sent } = makeService(db);
        service.now = () => noon;
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal(sent.length, 1, "only A is confirmed");
        assert.ok(sent[0].content.includes("A"));
        let s: any = await db.get("autoDailyState.99");
        assert.equal(s.status, "retry", "B is only a first sighting");
        assert.deepEqual(s.expiredSeen, { "2": noon }, "A's sighting is gone, B's is its own");
        const stored = (await storedAccounts(db, "99"))!;
        assert.equal(stored[0].tokenExpiredNotified, true);
        assert.equal(stored[1].tokenExpiredNotified, undefined);

        // B recovers (login works again): the sighting is cleared and the day is done
        calls = [];
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        await db.set("99.accounts", [{ info: { id: "2", nickname: "B" }, roles: [{ gameId: 1, uid: "6", nickName: "y", roles: [] }] }]);
        service.now = () => noon + 3600 * 1000;
        await service.processUser("99", config({ notify: false }), 102);
        s = await db.get("autoDailyState.99");
        assert.equal(s.status, "done");
        assert.equal(s.expiredSeen, undefined);
        assert.equal(s.expiredSeenAt, undefined);
      } finally {
        cleanup();
      }
    }

    // --- a refresh that could not tell (outage) is neither a sighting nor a DM ---------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [{ info: { id: "1", nickname: "A" }, invalid: true }]);
        accountUtils.wasRefreshInconclusive = (account: any) => account.info.id === "1";
        const { service, sent } = makeService(db);
        const noon = Date.parse(`${today}T12:00:00+08:00`);
        let t = noon;
        service.now = () => t;
        for (const [hr, plus] of [[101, 0], [102, 31], [103, 62]] as const) {
          t = noon + plus * 60 * 1000;
          await service.processUser("99", config({ notify: true }), hr);
        }
        assert.equal(sent.length, 0, "an outage never produces a DM or an error line while retrying");
        const s: any = await db.get("autoDailyState.99");
        assert.equal(s.status, "retry");
        assert.equal(s.attempts, 3);
        assert.equal(s.expiredSeen, undefined, "no sighting without evidence");
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, undefined);
      } finally {
        accountUtils.wasRefreshInconclusive = originals.wasRefreshInconclusive;
        cleanup();
      }
    }

    // --- an attendance 401 (token_expired) follows the same rule ------------------------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "A" }, roles: [{ gameId: 1, uid: "5", nickName: "x", roles: [] }] },
        ]);
        attendance = () => ({ error: true, errorKind: "token_expired", message: "x", nickname: "n" });
        const { service, sent } = makeService(db);
        const noon = Date.parse(`${today}T12:00:00+08:00`);
        let t = noon;
        service.now = () => t;
        await service.processUser("99", config({ notify: true }), 101);
        assert.equal(sent.length, 0);
        assert.equal(((await db.get("autoDailyState.99")) as any).status, "retry");
        t = noon + 60 * 60 * 1000;
        await service.processUser("99", config({ notify: true }), 102);
        assert.equal(sent.length, 1, "confirmed an hour later");
        assert.equal(((await db.get("autoDailyState.99")) as any).status, "failed");

        // same 401 while the refresh was inconclusive: an outage, never a sighting
        await db.set("98.accounts", [
          { info: { id: "9", nickname: "Z" }, roles: [{ gameId: 1, uid: "5", nickName: "x", roles: [] }] },
        ]);
        accountUtils.wasRefreshInconclusive = () => true;
        t = noon;
        await service.processUser("98", config({ notify: true }), 101);
        t = noon + 60 * 60 * 1000;
        await service.processUser("98", config({ notify: true }), 102);
        assert.equal(sent.length, 1);
        assert.equal(((await db.get("autoDailyState.98")) as any).status, "retry");
        assert.equal(((await db.get("autoDailyState.98")) as any).expiredSeen, undefined);
      } finally {
        accountUtils.wasRefreshInconclusive = originals.wasRefreshInconclusive;
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        cleanup();
      }
    }

    // --- failures: transient ones retry quietly, permanent ones end the day with one notice ---
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          {
            info: { id: "1", nickname: "Main" },
            roles: [
              { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [EF_ROLE], defaultRole: null },
            ],
          },
        ]);
        calls = [];
        const { service, sent } = makeService(db);
        // HTTP 500: the request layer reports a transient failure
        attendance = (_r, _g, options) => {
          options?.onError?.({ kind: "server", status: 500 });
          return { error: true, errorKind: "error", message: "HTTP 500 boom", nickname: "Endmin" };
        };
        await service.processUser("99", config({ mention: true }), 101);
        assert.equal(sent.length, 0, "a failure that will be retried says nothing");
        let state: any = await db.get("autoDailyState.99");
        assert.equal(state.status, "retry");
        assert.equal(state.attempts, 1);
        assert.equal(state.lastError, "HTTP 500 boom");
        assert.equal(await db.get("99.lastAutoDaily"), null, "not marked done");

        // The stored Endfield role is what gets signed (not the binding's uid / channelMasterId).
        assert.equal(calls.length, 1);
        assert.equal(calls[0].gameId, 3);
        assert.equal(calls[0].role.roleId, "6600112233");
        assert.equal(calls[0].role.serverId, "2");

        // retry (next hour) fails again: still quiet, attempts grow
        await service.processUser("99", config(), 102);
        assert.equal(sent.length, 0);
        state = await db.get("autoDailyState.99");
        assert.equal(state.attempts, 2);
        assert.equal(state.status, "retry");

        // retry succeeds: done, and the legacy marker is written for rollback
        attendance = () => ({ signedNow: false, hasToday: true, nickname: "Endmin" });
        await service.processUser("99", config({ notify: false }), 103);
        state = await db.get("autoDailyState.99");
        assert.equal(state.status, "done");
        assert.equal(state.attempts, 3);
        assert.equal(await db.get("99.lastAutoDaily"), today);
        const callCount = calls.length;
        await service.processUser("99", config({ notify: false }), 104);
        assert.equal(calls.length, callCount, "a finished day is not run again");
      } finally {
        cleanup();
      }
    }

    // timeout / network / 429 are transient too; a 4xx without such a signal is permanent
    for (const [name, failure, expected] of [
      ["timeout", { kind: "timeout" }, "retry"],
      ["network", { kind: "network" }, "retry"],
      ["429", { kind: "rate_limited", status: 429 }, "retry"],
      ["HTTP 400", { kind: "other", status: 400 }, "failed"],
      ["no signal at all", null, "failed"],
    ] as const) {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Main" }, roles: [{ gameId: 3, uid: "1", roles: [EF_ROLE] }] },
        ]);
        const { service, sent } = makeService(db);
        attendance = (_r, _g, options) => {
          if (failure) options?.onError?.(failure);
          return { error: true, errorKind: "error", message: `boom ${name}`, nickname: "Endmin" };
        };
        await service.processUser("99", config({ mention: true }), 101);
        const state: any = await db.get("autoDailyState.99");
        assert.equal(state.status, expected, name);
        if (expected === "retry") {
          assert.equal(sent.length, 0, name);
        } else {
          assert.equal(sent.length, 1, `${name}: one final notice`);
          assert.ok(sent[0].content.startsWith("<@99>\n"));
          assert.ok(sent[0].content.includes(`boom ${name}`), "the real reason is shown");
          assert.ok(!sent[0].content.toLowerCase().includes("already"));
          // never tried again today
          assert.equal(planAutoDaily(Date.parse(`${today}T23:30:00+08:00`), { time: 0 }, state), "skip");
        }
      } finally {
        cleanup();
      }
    }

    // a thrown network error retries; a thrown plain error does not
    for (const [err, expected] of [
      [Object.assign(new Error("socket"), { code: "ECONNRESET" }), "retry"],
      [new Error("bad data"), "failed"],
    ] as const) {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Main" }, roles: [{ gameId: 3, uid: "1", roles: [EF_ROLE] }] },
        ]);
        const { service } = makeService(db);
        attendance = () => {
          throw err;
        };
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal(((await db.get("autoDailyState.99")) as any).status, expected, String(err.message));
      } finally {
        cleanup();
      }
    }

    // transient errors that never go away: quiet until the last attempt, then one notice
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Main" }, roles: [{ gameId: 3, uid: "1", roles: [EF_ROLE] }] },
        ]);
        await db.set("autoDailyState.99", { date: today, status: "retry", attempts: 5, nextAttemptAt: 0 });
        const { service, sent } = makeService(db);
        attendance = (_r, _g, options) => {
          options?.onError?.({ kind: "timeout" });
          return { error: true, errorKind: "error", message: "timed out", nickname: "Endmin" };
        };
        await service.processUser("99", config({ mention: false }), 101);
        const state: any = await db.get("autoDailyState.99");
        assert.equal(state.status, "failed");
        assert.equal(state.attempts, 6);
        assert.equal(sent.length, 1);
        assert.ok(sent[0].content.includes("timed out"));
      } finally {
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        cleanup();
      }
    }

    // --- at most 40 expired-login DMs per tick; the rest end the day quietly ----------------
    {
      const { db, cleanup } = tempDb();
      try {
        const ago = Date.now() - 31 * 60 * 1000;
        for (let n = 0; n < 45; n++) {
          await db.set(`1${n}.accounts`, [{ info: { id: `acc${n}`, nickname: `Dead ${n}` }, invalid: true }]);
          await db.set(`autoDaily.1${n}`, config({ notify: true }));
          await db.set(`autoDailyState.1${n}`, {
            date: today,
            status: "retry",
            attempts: 1,
            nextAttemptAt: 0,
            expiredSeen: { [`acc${n}`]: ago },
            expiredSeenAt: ago,
          });
        }
        const { service, sent } = makeService(db);
        const logs: string[] = [];
        (service as any).logger.info = (m: string) => void logs.push(String(m));
        await (service as any).runHourlyCheck();
        assert.equal(MAX_EXPIRED_DMS_PER_TICK, 40);
        assert.equal(sent.length, 40, "40 DMs, not 45");
        assert.ok(logs.some((l) => l.includes("40 sent, 5 deferred")), "one summary line per tick");
        let flagged = 0;
        let failedQuietly = 0;
        for (let n = 0; n < 45; n++) {
          const acc = (await storedAccounts(db, `1${n}`))![0];
          const state: any = await db.get(`autoDailyState.1${n}`);
          if (acc.tokenExpiredNotified) flagged++;
          else {
            assert.equal(state.status, "failed", "deferred: the day ends as failed");
            failedQuietly++;
          }
        }
        assert.equal(flagged, 40);
        assert.equal(failedQuietly, 5);
        assert.ok(sent.every((p) => p.content.includes("/login")), "no error line for a deferred account");

        // next tick (new counter): the deferred ones are `failed` for today, so they wait for a later day
        await (service as any).runHourlyCheck();
        assert.equal(sent.length, 40);
      } finally {
        cleanup();
      }
    }

    // --- tick budget: no new user after 50 minutes; the rest go to the next tick ---------------
    {
      const { db, cleanup } = tempDb();
      try {
        for (let n = 0; n < 5; n++) {
          await db.set(`2${n}.accounts`, [
            { info: { id: `b${n}` }, roles: [{ gameId: 1, uid: `${n + 1}`, nickName: "x", roles: [] }] },
          ]);
          await db.set(`autoDaily.2${n}`, config({ notify: false }));
        }
        const { service } = makeService(db);
        let clock = Date.parse(`${today}T08:00:00+08:00`);
        service.now = () => clock;
        const processed: string[] = [];
        const warns: string[] = [];
        (service as any).logger.warn = (m: string) => void warns.push(String(m));
        const original = service.processUser.bind(service);
        service.processUser = async (userId: string, cfg: any, hour?: number) => {
          processed.push(userId);
          assert.equal(hour, undefined, "a regular tick never passes the tick's hour down");
          await original(userId, cfg, hour);
          clock += 30 * 60 * 1000; // each user "takes" 30 minutes
        };
        await (service as any).runHourlyCheck();
        assert.equal(processed.length, 2, "started at 0 and 30 minutes, not at 60");
        assert.ok(warns.some((w) => w.includes("3 of 5 users left")), warns.join("|"));
        await (service as any).runHourlyCheck();
        assert.equal(processed.length, 4);
        await (service as any).runHourlyCheck();
        assert.equal(processed.length, 5);
        for (let n = 0; n < 5; n++) assert.equal(((await db.get(`autoDailyState.2${n}`)) as any).status, "done");
      } finally {
        cleanup();
      }
    }

    // --- the claim key uses the hour in which the user is actually processed --------------------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("30.accounts", [
          { info: { id: "c" }, roles: [{ gameId: 1, uid: "9", nickName: "x", roles: [] }] },
        ]);
        await db.set("autoDaily.30", config({ time: 12, notify: false }));
        const { service } = makeService(db);
        let clock = Date.parse(`${today}T12:59:00+08:00`); // the tick starts in hour 12
        service.now = () => clock;
        const original = service.processUser.bind(service);
        service.processUser = async (userId: string, cfg: any, hour?: number) => {
          clock = Date.parse(`${today}T13:05:00+08:00`); // ...but this user's turn comes in hour 13
          await original(userId, cfg, hour);
        };
        await (service as any).runHourlyCheck();
        assert.equal(((await db.get("autoDailyState.30")) as any).status, "done");
        assert.equal(db.claimSlot("30.autoDailyHour", `${today}T13`), false, "claimed as hour 13");
        assert.equal(db.claimSlot("30.autoDailyHour", `${today}T12`), true, "hour 12 was never claimed");
      } finally {
        cleanup();
      }
    }

    // --- start(): the next tick is scheduled before the (long) first check -----------------------
    {
      const { db, cleanup } = tempDb();
      try {
        const { service } = makeService(db);
        const order: string[] = [];
        (service as any).scheduleNextRun = () => void order.push("schedule");
        (service as any).runHourlyCheck = async () => void order.push("check");
        await service.start();
        assert.deepEqual(order, ["schedule", "check"]);
      } finally {
        cleanup();
      }
    }

    // --- scope fallback: a role-less Endfield binding does not widen the scope --------------------
    {
      const { db, cleanup } = tempDb();
      try {
        const efNoRole = { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null };
        const ak = { gameId: 1, uid: "515336528", nickName: "AK", channelMasterId: "6", roles: [], defaultRole: null };
        await db.set("40.accounts", [{ info: { id: "d" }, roles: [ak, efNoRole] }]);
        // a scope saved as "arknights" but the account has only an Endfield role: widened
        await db.set("41.accounts", [{ info: { id: "e" }, roles: [{ gameId: 3, uid: "1", roles: [EF_ROLE] }] }]);
        calls = [];
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        const { service, sent } = makeService(db);
        await service.processUser("40", config({ game_scope: "endfield" }), 101);
        assert.equal(calls.length, 0, "scope endfield + role-less Endfield binding: Arknights is NOT signed");
        assert.equal(sent.length, 0);
        assert.equal(((await db.get("autoDailyState.40")) as any).status, "done");
        await service.processUser("41", config({ game_scope: "arknights" }), 101);
        assert.deepEqual(calls.map((c) => c.gameId), [3], "mis-saved scope with no binding for it still widens");
      } finally {
        cleanup();
      }
    }

    // --- legacy: lastAutoDaily === today and no state row -> done, nothing runs ----
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          { info: { id: "1", nickname: "Main" }, roles: [{ gameId: 1, uid: "5", nickName: "x", roles: [] }] },
        ]);
        await db.set("99.lastAutoDaily", today);
        calls = [];
        const { service, sent } = makeService(db);
        await service.processUser("99", config(), 101);
        assert.equal(calls.length, 0);
        assert.equal(sent.length, 0);
        assert.equal(((await db.get("autoDailyState.99")) as any).status, "done");
      } finally {
        cleanup();
      }
    }

    // --- hourly check: catch-up, skip finished, both games in one run --------------
    {
      const { db, cleanup } = tempDb();
      try {
        const bindings = [
          { gameId: 1, uid: "515336528", nickName: "AK", channelMasterId: "6", roles: [], defaultRole: null },
          { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [EF_ROLE], defaultRole: null },
        ];
        await db.set("10.accounts", [{ info: { id: "a" }, roles: bindings }]);
        await db.set("11.accounts", [{ info: { id: "b" }, roles: bindings }]);
        // time 0: the hour has always passed, so this is "catch up after downtime"
        await db.set("autoDaily.10", config({ notify: false }));
        await db.set("autoDaily.11", config({ notify: false }));
        await db.set("autoDailyState.11", { date: today, status: "done", attempts: 1 });
        calls = [];
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        const { service } = makeService(db);
        await (service as any).runHourlyCheck();
        assert.deepEqual(
          calls.map((c) => [c.gameId, c.role.roleId]),
          [
            [1, "515336528"],
            [3, "6600112233"],
          ],
          "user 11 is done and skipped; user 10 signs Arknights and Endfield",
        );
        assert.equal(((await db.get("autoDailyState.10")) as any).status, "done");
      } finally {
        cleanup();
      }
    }

    // --- an Endfield binding without a role is "no role", not an error ---------------
    {
      const { db, cleanup } = tempDb();
      try {
        const efNoRole = { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null };
        const ak = { gameId: 1, uid: "515336528", nickName: "AK", channelMasterId: "6", roles: [], defaultRole: null };
        // 1) only an Endfield binding without a role: silent, done, no DM, no API call
        await db.set("20.accounts", [{ info: { id: "a", nickname: "OnlyEF" }, roles: [efNoRole] }]);
        // 2) scope both, Arknights has a role, Endfield does not: Arknights is signed, done
        await db.set("21.accounts", [{ info: { id: "b", nickname: "Both" }, roles: [ak, efNoRole] }]);
        calls = [];
        attendance = () => ({ signedNow: true, hasToday: true, nickname: "n" });
        const { service, sent } = makeService(db);
        await service.processUser("20", config({ game_scope: "endfield" }), 101);
        assert.equal(calls.length, 0, "nothing is signed from the binding's uid");
        assert.equal(sent.length, 0, "no error card, no DM");
        const s20: any = await db.get("autoDailyState.20");
        assert.equal(s20.status, "done");
        assert.equal(s20.attempts, 1);
        assert.equal(s20.lastError, undefined);
        await service.processUser("21", config({ game_scope: "both" }), 101);
        assert.deepEqual(calls.map((c) => [c.gameId, c.role.roleId]), [[1, "515336528"]]);
        assert.equal(((await db.get("autoDailyState.21")) as any).status, "done");
        assert.equal(sent.filter((p) => p.content && /❌|⚠️/.test(p.content)).length, 0);
      } finally {
        cleanup();
      }
    }

    // --- manual hour range: configured hour only, finished users skipped ---------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("10.accounts", [{ info: { id: "a" }, roles: [{ gameId: 3, uid: "1", roles: [EF_ROLE] }] }]);
        await db.set("autoDaily.10", config({ time: 5, notify: false }));
        calls = [];
        const { service } = makeService(db);
        await service.manualRunRange(4, 4);
        assert.equal(calls.length, 0);
        await service.manualRunRange(5, 5);
        assert.equal(calls.length, 1);
      } finally {
        cleanup();
      }
    }

    // --- user with no accounts: nothing to do, day is done -------------------------
    {
      const { db, cleanup } = tempDb();
      try {
        const { service, sent } = makeService(db);
        await service.processUser("77", config(), 101);
        assert.equal(sent.length, 0);
        assert.equal(((await db.get("autoDailyState.77")) as any).status, "done");
      } finally {
        cleanup();
      }
    }

    console.log("AutoDaily checks passed");
  } finally {
    Object.assign(accountUtils, { ensureAccountBinding: originals.ensureAccountBinding });
    Object.assign(attendanceUtils, { processRoleAttendance: originals.processRoleAttendance });
    Object.assign(skportApi, { getGamePlayerBinding: originals.getGamePlayerBinding });
    accountUtils.wasRefreshInconclusive = originals.wasRefreshInconclusive;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
