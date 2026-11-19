process.env.ENCRYPTION_KEY = "ab".repeat(32); // test key (64 hex chars)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "../utils/Database";
import { patchAccount } from "../utils/accountData";
import { AutoDailyService } from "./AutoDailyService";
import { taipeiDate } from "./autoDailyPlan";

// The service calls these through its imports, so replacing the module properties works.
const accountUtils = require("../utils/accountUtils");
const attendanceUtils = require("../utils/attendanceUtils");
const skportApi = require("../utils/skportApi");
const originals = {
  ensureAccountBinding: accountUtils.ensureAccountBinding,
  processRoleAttendance: attendanceUtils.processRoleAttendance,
  getGamePlayerBinding: skportApi.getGamePlayerBinding,
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
const storedAccounts = (db: CustomDatabase, userId: string) =>
  db.get<any[]>(`${userId}.accounts`);

async function main() {
  accountUtils.ensureAccountBinding = async () => {};
  skportApi.getGamePlayerBinding = async () => null;
  let calls: any[] = [];
  let attendance: (role: any, gameId: number) => any = () => ({
    signedNow: true,
    hasToday: true,
    nickname: "n",
  });
  attendanceUtils.processRoleAttendance = async (role: any, gameId: number) => {
    calls.push({ role, gameId });
    return attendance(role, gameId);
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
        const { service } = makeService(db, () => new Error("network down"));
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal((await storedAccounts(db, "99"))![0].tokenExpiredNotified, undefined);
      } finally {
        cleanup();
      }
    }

    // --- first sighting of a dead token is only confirmed an hour later ----------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [{ info: { id: "1", nickname: "A" } }]);
        // Simulates ensureAccountBinding failing all recovery steps (e.g. SKPort outage).
        accountUtils.ensureAccountBinding = async (account: any, userId: string) => {
          account.invalid = true;
          patchAccount(db, userId, "1", { invalid: true });
        };
        const { service, sent } = makeService(db);
        await service.processUser("99", config({ notify: false }), 101);
        assert.equal(sent.length, 0, "no DM on the first sighting");
        const s1: any = await db.get("autoDailyState.99");
        assert.equal(s1.status, "retry");
        assert.equal(s1.attempts, 1);
        assert.ok(s1.nextAttemptAt > Date.now());

        await service.processUser("99", config({ notify: false }), 102);
        assert.equal(sent.length, 1, "second sighting confirms it and sends the DM");
        assert.equal(((await db.get("autoDailyState.99")) as any).status, "failed");
      } finally {
        accountUtils.ensureAccountBinding = async () => {};
        cleanup();
      }
    }

    // --- failures are reported honestly and retried; success marks the day done ---
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("99.accounts", [
          {
            info: { id: "1", nickname: "Main" },
            roles: [
              { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null },
            ],
          },
        ]);
        const { service, sent } = makeService(db);
        attendance = () => ({
          error: true,
          errorKind: "error",
          message: "HTTP 500 boom",
          nickname: "Endmin",
        });
        await service.processUser("99", config({ mention: true }), 101);
        assert.equal(sent.length, 1);
        assert.ok(sent[0].content.startsWith("<@99>\n"));
        assert.ok(sent[0].content.includes("HTTP 500 boom"), "real reason is shown");
        assert.ok(!sent[0].content.toLowerCase().includes("already"));
        let state: any = await db.get("autoDailyState.99");
        assert.equal(state.status, "retry");
        assert.equal(state.attempts, 1);
        assert.equal(state.lastError, "HTTP 500 boom");
        assert.equal(await db.get("99.lastAutoDaily"), null, "not marked done");

        // The synthesized Endfield role is what gets signed.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].gameId, 3);
        assert.equal(calls[0].role.roleId, "837903459");
        assert.equal(calls[0].role.serverId, "6");

        // retry (next hour) fails again: stays quiet, attempts grow
        await service.processUser("99", config(), 102);
        assert.equal(sent.length, 1, "a retry that fails again does not repeat the error");
        state = await db.get("autoDailyState.99");
        assert.equal(state.attempts, 2);

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
          { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null },
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
            [3, "837903459"],
          ],
          "user 11 is done and skipped; user 10 signs Arknights and Endfield",
        );
        assert.equal(((await db.get("autoDailyState.10")) as any).status, "done");
      } finally {
        cleanup();
      }
    }

    // --- manual hour range: configured hour only, finished users skipped ---------
    {
      const { db, cleanup } = tempDb();
      try {
        await db.set("10.accounts", [{ info: { id: "a" }, roles: [{ gameId: 3, uid: "1", roles: [] }] }]);
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
