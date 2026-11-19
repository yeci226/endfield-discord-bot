import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";
import {
  accountFingerprint,
  deleteAccountData,
  writeAccounts,
} from "./accountData";
import { handleAccountUnbind, promptAccountUnbind } from "./accountUnbind";
import { decryptAccount } from "./cryptoUtils";

const account = (id: string, roleId: string) => ({
  info: { id, nickname: `Account ${id}` },
  cookie: `cookie-${id}`,
  cred: `cred-${id}`,
  salt: `salt-${id}`,
  roles: [
    { gameId: 3, uid: `binding-${id}`, roles: [{ roleId, serverId: "2" }] },
  ],
});
const snapshot = async (db: CustomDatabase) =>
  (await db.all()).sort((a, b) => a.id.localeCompare(b.id));
const fingerprint = async (db: CustomDatabase, index = 0) =>
  accountFingerprint((await db.get<any[]>("owner.accounts"))![index]);

async function main() {
  process.env.ENCRYPTION_KEY = "account-deletion-test-key";
  const db = new CustomDatabase(":memory:");
  const first = account("1", "101");
  const second = account("10", "202");
  writeAccounts(db, "owner", [first, second], true);
  assert.notEqual(
    (await db.get<any[]>("owner.accounts"))![0].cookie,
    first.cookie,
  );
  for (const uid of [
    "101",
    "EF_101",
    "EF_CN_101",
    "EF_binding-1",
    "EF_202",
    "EF_1010",
    "EF_GUEST_owner_123",
  ]) {
    await db.set(`GACHA_LOG_${uid}`, { uid });
    await db.set(`SIM_POOL_RECORDS.${uid}`, { pool: uid });
  }
  await db.set("GACHA_LEADERBOARD_ENTRIES", {
    EF_101: {},
    EF_CN_101: {},
    "EF_binding-1": {},
    EF_202: {},
    EF_1010: {},
  });
  // New per-UID rows: leaderboard and stats cache, for every key form.
  const lbUids = ["101", "EF_101", "EF_CN_101", "EF_binding-1", "EF_202", "EF_1010", "EF_GUEST_owner_123"];
  for (const uid of lbUids) {
    await db.set(`GACHA_LB.${uid}`, { uid, guilds: [] });
    await db.set(`GACHA_STATS.GACHA_LOG_${uid}`, { uid });
  }
  const removedKeys = [
    "reminder.v2.owner.1.2.101",
    "reminderState.v2.owner.1.2.101",
    "owner.cookie",
    "owner.cred",
    "owner.salt",
    "PENDING_GACHA_URL_owner",
    "PENDING_GACHA_FINGERPRINT_owner",
    "warEchoes.history.101",
  ];
  for (const key of removedKeys) await db.set(key, "sensitive");
  await db.set("owner.info", first.info);
  const keptKeys = [
    "reminder.v2.owner.10.2.202",
    "reminderState.v2.owner.10.2.202",
    "reminder.v2.other.1.2.101",
    "autoDaily.owner",
    "owner.lastAutoDaily",
    "profile.owner.template",
    "owner.locale",
    "GACHA_POOL_NAMES",
    "SIM_POOL_RECORDS.GLOBAL",
    "autoDaily.other",
  ];
  for (const key of keptKeys) await db.set(key, { keep: true });
  await db.set("autoDaily", { owner: true, other: true });
  await db.set("monitorConfig", { owner: true, other: true });
  await db.set("profile_edit_token:own", { userId: "owner" });
  await db.set("profile_edit_token:other", { userId: "other" });
  await db.set("reminderWizard.session.v1.own", { owner: "owner", detail: {} });
  await db.set("reminderWizard.session.v1.other", {
    owner: "other",
    detail: {},
  });
  const originalSecond = (await db.get<any[]>("owner.accounts"))![1];
  const token = await fingerprint(db);
  const before = await snapshot(db);

  // Any failure, even after all deletion work, must roll back the entire operation.
  const transaction = db.transaction.bind(db);
  db.transaction = (callback) =>
    transaction((store) => {
      callback(store);
      throw new Error("injected write failure");
    });
  assert.throws(() => deleteAccountData(db, "owner", token), /injected/);
  assert.deepEqual(await snapshot(db), before);
  db.transaction = transaction;
  assert.equal(deleteAccountData(db, "owner", token)?.info.id, "1");
  for (const key of [
    ...removedKeys,
    "owner.info",
    "GACHA_LOG_EF_101",
    "GACHA_LOG_EF_CN_101",
    "GACHA_LOG_101",
    "SIM_POOL_RECORDS.EF_101",
    "GACHA_LOG_EF_binding-1",
  ])
    assert.equal(await db.get(key), null, key);
  for (const key of keptKeys)
    assert.deepEqual(await db.get(key), { keep: true }, key);
  // No row of the removed account is left among the new prefixes ...
  for (const prefix of ["GACHA_LB.", "GACHA_STATS.", "PENDING_GACHA_"])
    for (const key of db.findKeysByPrefix(prefix))
      assert.ok(
        !/(^|[._])(EF_CN_|EF_)?(101|binding-1)$/.test(key) && !key.endsWith("_owner"),
        `leftover ${key}`,
      );
  // ... and the other account's rows stay.
  for (const uid of ["EF_202", "EF_1010", "EF_GUEST_owner_123"]) {
    assert.ok(await db.get(`GACHA_LB.${uid}`), uid);
    assert.ok(await db.get(`GACHA_STATS.GACHA_LOG_${uid}`), uid);
  }
  for (const uid of ["EF_202", "EF_1010", "EF_GUEST_owner_123"])
    assert.ok(await db.get(`GACHA_LOG_${uid}`));
  assert.deepEqual(await db.get("GACHA_LEADERBOARD_ENTRIES"), {
    EF_202: {},
    EF_1010: {},
  });
  assert.deepEqual(await db.get("owner.accounts"), [originalSecond]);
  assert.equal(await db.get("reminderWizard.session.v1.own"), null);
  assert.ok(await db.get("reminderWizard.session.v1.other"));

  // A background refresh holding the pre-deletion list must not restore the removed account.
  writeAccounts(db, "owner", [first, second]);
  assert.equal((await db.get<any[]>("owner.accounts"))!.length, 1);
  assert.equal(deleteAccountData(db, "owner", token), null);
  deleteAccountData(db, "owner", await fingerprint(db));
  for (const key of [
    "owner.accounts",
    "autoDaily.owner",
    "owner.lastAutoDaily",
    "profile.owner.template",
    "profile_edit_token:own",
    "GACHA_LOG_EF_202",
    "reminder.v2.owner.10.2.202",
  ])
    assert.equal(await db.get(key), null, key);
  assert.deepEqual(await db.get("autoDaily"), { other: true });
  assert.deepEqual(await db.get("monitorConfig"), { other: true });
  assert.ok(await db.get("profile_edit_token:other"));
  assert.ok(await db.get("owner.locale"));
  writeAccounts(db, "owner", [first, second]);
  assert.equal(await db.get("owner.accounts"), null);

  // Rebinding is explicit; the old confirmation cannot remove the new binding.
  writeAccounts(db, "owner", [first], true);
  assert.equal(deleteAccountData(db, "owner", token), null);
  assert.equal(
    decryptAccount((await db.get<any[]>("owner.accounts"))![0]).cookie,
    first.cookie,
  );

  // Nested bindings and a shared role: keep history still used by another bound account.
  const nested = {
    ...account("3", "303"),
    roles: [{ bindingList: [{ gameId: 3, defaultRole: { roleId: "303" } }] }],
  };
  writeAccounts(db, "owner", [nested, account("4", "303")], true);
  await db.set("GACHA_LOG_EF_303", { keep: true });
  deleteAccountData(db, "owner", await fingerprint(db, 1));
  assert.ok(await db.get("GACHA_LOG_EF_303"));

  // The dialog deletes nothing until the owner presses the valid confirmation.
  const ui = new CustomDatabase(":memory:");
  writeAccounts(ui, "owner", [first], true);
  let reply: any;
  const tr = (key: string) => key;
  await promptAccountUnbind(
    {
      user: { id: "owner" },
      reply: async (value: any) => {
        reply = value;
      },
    } as any,
    ui,
    first,
    tr,
  );
  const buttons = reply.components[0].toJSON().components[1].components;
  const customId = buttons[0].custom_id;
  assert.ok(customId.length <= 100);
  const click = (id: string, owner = "owner") => ({
    customId: id,
    user: { id: owner },
    reply: async (value: any) => {
      reply = value;
    },
    deferUpdate: async () => {},
    editReply: async (value: any) => {
      reply = value;
    },
  });
  await handleAccountUnbind(click(customId, "other") as any, ui, tr);
  assert.ok(await ui.get("owner.accounts"));
  await handleAccountUnbind(
    click(customId.replace(/:\d+:/, ":1:")) as any,
    ui,
    tr,
  );
  assert.ok(await ui.get("owner.accounts"));
  await handleAccountUnbind(click(buttons[1].custom_id) as any, ui, tr);
  assert.ok(await ui.get("owner.accounts"));
  await handleAccountUnbind(click(customId) as any, ui, tr);
  assert.equal(await ui.get("owner.accounts"), null);
  await handleAccountUnbind(click(customId) as any, ui, tr);
  assert.match(
    JSON.stringify(reply.components[0].toJSON()),
    /login_UnbindExpired/,
  );
  console.log(
    "Account deletion: atomic rollback, account isolation, alias cleanup, shared roles, refresh safety, rebind safety, and confirmation checks passed.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
