process.env.ENCRYPTION_KEY = "cd".repeat(32); // test key (64 hex chars)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";
import { patchAccount, deleteAccountData, accountFingerprint, applySuccessfulLogin, writeAccounts } from "./accountData";
import { decryptAccount } from "./cryptoUtils";

const skportApi = require("./skportApi");
const { ensureAccountBinding, getAccounts, wasRefreshInconclusive } = require("./accountUtils");
const axios = require("axios").default;

let counter = 0;
async function withDb(fn: (db: CustomDatabase) => Promise<void>) {
  const file = path.join(os.tmpdir(), `ef-acct-test-${process.pid}-${counter++}.sqlite`);
  const db = new CustomDatabase(file);
  try {
    await fn(db);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readList = (db: CustomDatabase, uid: string) => db.get<any[]>(`${uid}.accounts`);

async function main() {
  // --- patchAccount: patches survive each other, stale snapshots do not clobber ----
  await withDb(async (db) => {
    // legacy shapes: plaintext secrets, roles: [] on the account
    await db.set("u1.accounts", [
      { info: { id: "a1", nickname: "A" }, cookie: "plain-cookie", cred: "plain-cred", salt: "plain-salt", roles: [] },
      { info: { id: "a2", nickname: "B" }, cookie: "other-cookie" },
    ]);
    const stale = (await getAccounts(db, "u1"))[0]; // snapshot taken now
    assert.equal(stale.cred, "plain-cred", "legacy plaintext is still readable");

    assert.equal(patchAccount(db, "u1", "a1", { tokenExpiredNotified: true }), true);
    assert.equal(patchAccount(db, "u1", "a1", { cred: "new-cred", salt: "new-salt", lastRefresh: 5 }), true);
    // somebody holding the stale snapshot flags the account invalid
    assert.equal(patchAccount(db, "u1", "a1", { invalid: true }), true);

    const raw = (await readList(db, "u1"))!;
    assert.equal(raw[0].tokenExpiredNotified, true, "first patch survived the later ones");
    assert.equal(raw[0].lastRefresh, 5);
    assert.equal(raw[0].invalid, true);
    assert.equal(raw[0].cookie, "plain-cookie", "untouched plaintext secret stays as it was");
    assert.notEqual(raw[0].cred, "new-cred", "secrets in a patch are stored encrypted");
    assert.equal(decryptAccount(raw[0]).cred, "new-cred");
    assert.equal(decryptAccount(raw[0]).salt, "new-salt");
    assert.deepEqual(raw[0].roles, [], "roles: [] is left alone");
    assert.equal(raw[1].cookie, "other-cookie", "other accounts are untouched");

    patchAccount(db, "u1", "a1", { tokenExpiredNotified: undefined });
    assert.ok(!("tokenExpiredNotified" in (await readList(db, "u1"))![0]));

    // nothing is written for an unknown account or user; no row is recreated
    assert.equal(patchAccount(db, "u1", "nope", { x: 1 }), false);
    assert.equal(patchAccount(db, "ghost", "a1", { x: 1 }), false);
    assert.equal(await db.get("ghost.accounts"), null);
    assert.equal(patchAccount(db, "u1", "", { x: 1 }), false);
  });

  // --- ensureAccountBinding: lock, adopt, clear flag, keep concurrent writes -------
  await withDb(async (db) => {
    const roles = [{ gameId: 3, uid: "837903459", nickName: "N", channelMasterId: "6", roles: [], defaultRole: null }];
    await db.set("u2.accounts", [
      { info: { id: "a1", nickname: "A" }, cookie: "ACCOUNT_TOKEN=t", cred: "old-cred", salt: "old-salt", roles: [], invalid: true, tokenExpiredNotified: true },
    ]);
    const originals = {
      getUserInfo: skportApi.getUserInfo,
      refreshSkToken: skportApi.refreshSkToken,
      getGamePlayerBindingResponse: skportApi.getGamePlayerBindingResponse,
    };
    let userInfoCalls = 0;
    skportApi.getUserInfo = async () => {
      userInfoCalls++;
      await sleep(20);
      // another writer patches the same account while we are refreshing
      patchAccount(db, "u2", "a1", { note: "written meanwhile" });
      return { code: 0 };
    };
    skportApi.refreshSkToken = async () => "fresh-salt";
    skportApi.getGamePlayerBindingResponse = async () => ({ code: 0, data: { list: [{ bindingList: roles }] } });
    try {
      const [a, b] = [(await getAccounts(db, "u2"))[0], (await getAccounts(db, "u2"))[0]];
      const [ra, rb] = await Promise.all([
        ensureAccountBinding(a, "u2", db, "tw", true),
        ensureAccountBinding(b, "u2", db, "tw", true),
      ]);
      assert.equal(userInfoCalls, 1, "the second caller adopted the first refresh instead of refreshing again");
      assert.ok(ra && rb);
      assert.equal(b.invalid, false);
      assert.equal(b.salt, "fresh-salt");
      assert.equal(b.tokenExpiredNotified, undefined);

      const stored = (await readList(db, "u2"))![0];
      assert.equal(stored.invalid, false);
      assert.ok(!("tokenExpiredNotified" in stored), "flag cleared by a working token");
      assert.equal(stored.note, "written meanwhile", "a concurrent write was not overwritten");
      assert.equal(decryptAccount(stored).salt, "fresh-salt");
      assert.equal(stored.roles.length, 1);
      assert.equal(stored.info.nickname, "A");

      // a recent, valid account with a role short-circuits: no network at all
      userInfoCalls = 0;
      const c = (await getAccounts(db, "u2"))[0];
      assert.equal(await ensureAccountBinding(c, "u2", db, "tw"), false);
      assert.equal(userInfoCalls, 0);

      // an Endfield binding without any role also short-circuits (no refresh on every use)
      await db.set("u2b.accounts", [
        { info: { id: "n1" }, cookie: "ACCOUNT_TOKEN=t", cred: "c", salt: "s", lastRefresh: Date.now(), roles: [{ gameId: 3, uid: "1", roles: [], defaultRole: null }] },
      ]);
      const d = (await getAccounts(db, "u2b"))[0];
      assert.equal(await ensureAccountBinding(d, "u2b", db, "tw"), false);
      assert.equal(userInfoCalls, 0);
    } finally {
      Object.assign(skportApi, originals);
    }
  });

  // --- ensureAccountBinding marks a dead account invalid without touching the rest --
  await withDb(async (db) => {
    await db.set("u3.accounts", [
      { info: { id: "a1" }, cookie: "plain-cookie", cred: "plain-cred", salt: "s", roles: [], extra: 1 },
    ]);
    const originals = {
      getUserInfo: skportApi.getUserInfo,
      refreshSkToken: skportApi.refreshSkToken,
      refreshAccountToken: skportApi.refreshAccountToken,
    };
    skportApi.getUserInfo = async () => ({ code: 10000, status: 401 });
    skportApi.refreshSkToken = async () => null;
    skportApi.refreshAccountToken = async () => null;
    try {
      const acc = (await getAccounts(db, "u3"))[0];
      assert.equal(await ensureAccountBinding(acc, "u3", db, "tw"), true);
      const stored = (await readList(db, "u3"))![0];
      assert.equal(stored.invalid, true);
      assert.equal(stored.cookie, "plain-cookie");
      assert.equal(stored.cred, "plain-cred");
      assert.equal(stored.extra, 1);
    } finally {
      Object.assign(skportApi, originals);
    }
  });

  // --- request failure classification (fake axios errors) ---------------------------
  {
    const { classifyRequestError, isTransientFailure, isAuthRejectionCode } = skportApi;
    const noResp = (code: string, message = "boom") => Object.assign(new Error(message), { code, isAxiosError: true });
    const http = (status: number, data: any = {}) => Object.assign(new Error("x"), { isAxiosError: true, response: { status, data } });
    const table: Array<[string, any, string, boolean]> = [
      ["axios timeout", noResp("ECONNABORTED", "timeout of 15000ms exceeded"), "timeout", true],
      ["ETIMEDOUT", noResp("ETIMEDOUT"), "timeout", true],
      ["timeout message only", new Error("timeout of 15000ms exceeded"), "timeout", true],
      ["connection reset", noResp("ECONNRESET"), "network", true],
      ["dns failure", noResp("ENOTFOUND"), "network", true],
      ["HTTP 500", http(500), "server", true],
      ["HTTP 502", http(502), "server", true],
      ["HTTP 429", http(429), "rate_limited", true],
      ["HTTP 401", http(401, { code: 10000 }), "auth", false],
      ["HTTP 401 with clock-skew code 10003 is not a login rejection", http(401, { code: 10003 }), "other", false],
      ["HTTP 403", http(403), "auth", false],
      ["HTTP 404", http(404), "other", false],
    ];
    for (const [name, err, kind, transient] of table) {
      const f = classifyRequestError(err);
      assert.equal(f.kind, kind, name);
      assert.equal(isTransientFailure(f), transient, name);
    }
    assert.ok(isAuthRejectionCode(10000, 401));
    assert.ok(isAuthRejectionCode(10002));
    assert.ok(isAuthRejectionCode(-1, 403));
    assert.ok(!isAuthRejectionCode(10003, 401));
    assert.ok(!isAuthRejectionCode(500, 500));
    assert.ok(!isAuthRejectionCode(undefined, undefined));
    assert.equal(classifyRequestError(http(400), { tokenEndpoint: true }).kind, "auth");
    assert.equal(classifyRequestError(http(400)).kind, "other");
  }

  // --- makeRequest: 15 s timeout, failure kind reported, return value unchanged ------
  {
    const saved = axios.defaults.adapter;
    let seenTimeout: any;
    let behaviour: () => any = () => ({});
    axios.defaults.adapter = async (config: any) => {
      seenTimeout = config.timeout;
      const r = behaviour();
      if (r instanceof Error) throw r;
      return { data: r, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
      const kinds: string[] = [];
      const onError = (f: any) => kinds.push(f.kind);
      behaviour = () => Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED", isAxiosError: true });
      assert.equal(await skportApi.makeRequest("GET", "https://zonai.skport.com/web/v2/user", { onError }), null);
      assert.equal(seenTimeout, 15000, "every request is time-bounded");
      assert.deepEqual(kinds, ["timeout"]);
      // the 5xx body is still returned as before; the kind is reported on the side
      behaviour = () => Object.assign(new Error("x"), { isAxiosError: true, response: { status: 503, data: { code: 5 } } });
      assert.deepEqual(await skportApi.makeRequest("GET", "https://zonai.skport.com/web/v2/user", { onError }), { code: 5 });
      assert.deepEqual(kinds, ["timeout", "server"]);
      behaviour = () => ({ code: 0 });
      assert.deepEqual(await skportApi.makeRequest("GET", "https://zonai.skport.com/web/v2/user", { onError }), { code: 0 });
      assert.deepEqual(kinds, ["timeout", "server"], "success reports nothing");
    } finally {
      axios.defaults.adapter = saved;
    }
  }

  // --- refreshAccountBinding: only an explicit rejection marks the account invalid -------
  {
    const fail = (kind: string, status?: number) => ({ kind, ...(status ? { status } : {}) });
    const scenarios: Array<{
      name: string;
      account?: any;
      userInfo: (onError: any) => any;
      refreshSk: (onError: any) => any;
      refreshCookie: (onError: any) => any;
      invalid: boolean;
    }> = [
      {
        name: "timeouts everywhere: unknown, not invalid",
        userInfo: (e) => (e(fail("timeout")), null),
        refreshSk: (e) => (e(fail("timeout")), null),
        refreshCookie: (e) => (e(fail("timeout")), null),
        invalid: false,
      },
      {
        name: "HTTP 5xx: not invalid",
        userInfo: (e) => (e(fail("server", 503)), null),
        refreshSk: (e) => (e(fail("server", 502)), null),
        refreshCookie: (e) => (e(fail("server", 500)), null),
        invalid: false,
      },
      {
        name: "HTTP 429: not invalid",
        userInfo: (e) => (e(fail("rate_limited", 429)), null),
        refreshSk: (e) => (e(fail("rate_limited", 429)), null),
        refreshCookie: (e) => (e(fail("rate_limited", 429)), null),
        invalid: false,
      },
      {
        name: "auth rejection in two steps but the cookie step timed out: not invalid",
        userInfo: () => ({ code: 10000, status: 401 }),
        refreshSk: (e) => (e(fail("auth", 401)), null),
        refreshCookie: (e) => (e(fail("network")), null),
        invalid: false,
      },
      {
        name: "all steps explicitly rejected: invalid",
        userInfo: () => ({ code: 10000, status: 401 }),
        refreshSk: (e) => (e(fail("auth", 401)), null),
        refreshCookie: (e) => (e(fail("auth", 403)), null),
        invalid: true,
      },
      {
        name: "API 'not logged in' code 10002 in the body is a rejection",
        userInfo: () => ({ code: 10002 }),
        refreshSk: () => null,
        refreshCookie: () => null,
        invalid: true,
      },
      {
        name: "an unknown non-zero code with no signal is not enough",
        userInfo: () => ({ code: 1 }),
        refreshSk: () => null,
        refreshCookie: () => null,
        invalid: false,
      },
      {
        name: "no credentials at all is unusable",
        account: { cookie: "", cred: "", salt: "" },
        userInfo: () => null,
        refreshSk: () => null,
        refreshCookie: () => null,
        invalid: true,
      },
    ];
    for (const sc of scenarios) {
      await withDb(async (db) => {
        await db.set("u5.accounts", [
          { info: { id: "a1" }, cookie: "plain-cookie", cred: "plain-cred", salt: "s", roles: [], ...sc.account },
        ]);
        const originals = {
          getUserInfo: skportApi.getUserInfo,
          refreshSkToken: skportApi.refreshSkToken,
          refreshAccountToken: skportApi.refreshAccountToken,
        };
        skportApi.getUserInfo = async (_c: any, _l: any, _s: any, onError: any) => sc.userInfo(onError);
        skportApi.refreshSkToken = async (_c: any, _p: any, _s: any, onError: any) => sc.refreshSk(onError);
        skportApi.refreshAccountToken = async (_c: any, onError: any) => sc.refreshCookie(onError);
        try {
          const acc = (await getAccounts(db, "u5"))[0];
          await ensureAccountBinding(acc, "u5", db, "tw");
          const stored = (await readList(db, "u5"))![0];
          assert.equal(!!acc.invalid, sc.invalid, sc.name + " (memory)");
          assert.equal(!!stored.invalid, sc.invalid, sc.name + " (stored)");
          assert.equal(wasRefreshInconclusive(acc), !sc.invalid, sc.name + " (inconclusive flag)");
        } finally {
          Object.assign(skportApi, originals);
        }
      });
    }

    // An account that was already flagged stays flagged on a transient failure, but the
    // refresh reports that it could not tell (callers must not treat that as a confirmation).
    await withDb(async (db) => {
      await db.set("u6.accounts", [
        { info: { id: "a1" }, cookie: "plain-cookie", cred: "plain-cred", salt: "s", roles: [], invalid: true },
      ]);
      const originals = {
        getUserInfo: skportApi.getUserInfo,
        refreshSkToken: skportApi.refreshSkToken,
        refreshAccountToken: skportApi.refreshAccountToken,
      };
      skportApi.getUserInfo = async (_c: any, _l: any, _s: any, onError: any) => (onError(fail("timeout")), null);
      skportApi.refreshSkToken = async () => null;
      skportApi.refreshAccountToken = async () => null;
      try {
        const acc = (await getAccounts(db, "u6"))[0];
        await ensureAccountBinding(acc, "u6", db, "tw");
        assert.equal(acc.invalid, true, "the stored flag is not cleared by a failed refresh");
        assert.equal(wasRefreshInconclusive(acc), true);
      } finally {
        Object.assign(skportApi, originals);
      }
    });
  }

  // --- a successful re-login removes the expired markers ---------------------------------
  await withDb(async (db) => {
    const stale = { info: { id: "a1", nickname: "Old" }, cookie: "c0", cred: "k0", salt: "s0", roles: [], invalid: true, tokenExpiredNotified: true, keep: 1 };
    await db.set("u7.accounts", [stale]);
    const exists = (await getAccounts(db, "u7"))[0];
    assert.equal(exists.invalid, true);
    const fresh = { cookie: "c1", cred: "k1", salt: "s1", roles: [], lastRefresh: 5, info: { id: "a1", nickname: "New" } };
    assert.equal(applySuccessfulLogin(exists, fresh), exists);
    assert.ok(!("invalid" in exists) && !("tokenExpiredNotified" in exists));
    writeAccounts(db, "u7", [exists], true);
    const stored = (await readList(db, "u7"))![0];
    assert.ok(!("invalid" in stored), "stored invalid flag removed");
    assert.ok(!("tokenExpiredNotified" in stored), "stored notified flag removed");
    assert.equal(stored.keep, 1, "unrelated fields survive");
    assert.equal(stored.info.nickname, "New");
    assert.equal(decryptAccount(stored).cred, "k1");
  });

  // --- deleting the last account removes the auto-daily bookkeeping ----------------
  await withDb(async (db) => {
    const account = { info: { id: "a1", nickname: "A" }, roles: [] };
    await db.set("u4.accounts", [account]);
    for (const key of ["autoDaily.u4", "u4.lastAutoDaily", "autoDailyState.u4", "u4.autoDailyHour"])
      await db.set(key, { x: 1 });
    await db.set("autoDailyState.other", { x: 1 });
    assert.ok(deleteAccountData(db, "u4", accountFingerprint(account)));
    for (const key of ["autoDaily.u4", "u4.lastAutoDaily", "autoDailyState.u4", "u4.autoDailyHour", "u4.accounts"])
      assert.equal(await db.get(key), null, key);
    assert.deepEqual(await db.get("autoDailyState.other"), { x: 1 });
  });

  console.log("accountUtils checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
