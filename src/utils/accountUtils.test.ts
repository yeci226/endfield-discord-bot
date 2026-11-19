process.env.ENCRYPTION_KEY = "cd".repeat(32); // test key (64 hex chars)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";
import { patchAccount, deleteAccountData, accountFingerprint } from "./accountData";
import { decryptAccount } from "./cryptoUtils";

const skportApi = require("./skportApi");
const { ensureAccountBinding, getAccounts } = require("./accountUtils");

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
    skportApi.getUserInfo = async () => ({ code: 1 });
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
