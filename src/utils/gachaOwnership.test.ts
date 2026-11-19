import assert from "node:assert/strict";
import axios from "axios";

process.env.ENCRYPTION_KEY = "k".repeat(40);
process.env.GACHA_STRICT_IMPORT_HOSTS = "1";

import { CustomDatabase } from "./Database";
import {
  findLinkedAccount,
  isOwnGuestUid,
  listOwnedGachaUids,
  resolveOwnedGachaUid,
} from "../features/gacha/command/accounts";
import {
  getEmbeddedInvokerId,
  getMessageInvokerId,
  mayOperateGachaComponent,
} from "../features/gacha/command/components";
import {
  PENDING_GACHA_TTL_MS,
  pendingFingerprintKey,
  pendingUrlKey,
  readPending,
  savePending,
} from "../features/gacha/command/pending";
import { describeIncompleteFetches } from "../features/gacha/command/autoLoad";

const gachaCommand = require("../commands/general/gacha").default;

const OWNER = "111111111111111111";
const OTHER = "222222222222222222";
const OFFICIAL = "https://ef-webview.gryphline.com/page/gacha_char?token=tok&server_id=2";

const tr: any = (key: string, vars?: any) =>
  vars ? `${key}${JSON.stringify(vars)}` : key;
tr.lang = "tw";

function account(binding: string, role: string) {
  return {
    cookie: "ACCOUNT_TOKEN=x",
    info: { id: `hg-${binding}` },
    lastRefresh: Date.now(),
    roles: [
      {
        gameId: 3,
        uid: binding,
        nickName: "Nick",
        roles: [{ roleId: role, nickname: "Role" }],
      },
    ],
  };
}

function fakeInteraction(over: any) {
  const calls: Array<{ method: string; arg: any }> = [];
  const rec =
    (method: string, ret?: any) =>
    async (arg?: any) => {
      calls.push({ method, arg });
      return ret;
    };
  const base: any = {
    locale: "zh-TW",
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    deferReply: rec("deferReply"),
    deferUpdate: rec("deferUpdate"),
    editReply: rec("editReply"),
    followUp: rec("followUp"),
    reply: rec("reply"),
    update: rec("update"),
    showModal: rec("showModal"),
    deleteReply: rec("deleteReply"),
  };
  return { interaction: Object.assign(base, over), calls };
}

async function main() {
  // ---- Task 1: pure ownership ----
  const accounts = [account("1001", "2001")];
  const guest = `EF_GUEST_${OWNER}_1700000000000`;
  const owned = listOwnedGachaUids(accounts, OWNER, [
    guest,
    `EF_GUEST_${OTHER}_1700000000001`, // someone else's guest key
    `EF_GUEST_${OWNER}Xcollision`, // prefix collision, no "_"
  ]);
  for (const uid of ["EF_2001", "EF_CN_2001", "2001", "EF_1001", "EF_CN_1001", guest]) {
    assert.deepEqual(resolveOwnedGachaUid(uid, owned), { ok: true, uid }, uid);
  }
  assert.deepEqual(resolveOwnedGachaUid("EF_9999", owned), { ok: false, reason: "not_owned" });
  assert.deepEqual(resolveOwnedGachaUid("", owned), { ok: false, reason: "empty" });
  assert.deepEqual(resolveOwnedGachaUid(undefined, owned), { ok: false, reason: "empty" });
  assert.equal(resolveOwnedGachaUid(`EF_GUEST_${OTHER}_1700000000001`, owned).ok, false);
  assert.equal(resolveOwnedGachaUid(`EF_GUEST_${OWNER}Xcollision`, owned).ok, false);
  assert.equal(resolveOwnedGachaUid("EF_undefined", owned).ok, false);
  assert.equal(resolveOwnedGachaUid("EF_2001 ", owned).ok, true, "trimmed");
  assert.deepEqual(listOwnedGachaUids([], OWNER), []);
  assert.deepEqual(listOwnedGachaUids(null, OWNER), []);
  // no accounts: nothing but own guests
  assert.equal(resolveOwnedGachaUid("EF_2001", listOwnedGachaUids([], OWNER, [guest])).ok, false);
  assert.equal(resolveOwnedGachaUid(guest, listOwnedGachaUids([], OWNER, [guest])).ok, true);
  assert.equal(isOwnGuestUid(guest, OWNER), true);
  assert.equal(isOwnGuestUid(guest, OTHER), false);
  assert.equal(isOwnGuestUid(`EF_GUEST_${OWNER}_`, OWNER), false);
  // binding lists nested the way accountData reads them
  assert.equal(
    resolveOwnedGachaUid(
      "EF_3001",
      listOwnedGachaUids([{ roles: [{ bindingList: [{ gameId: 3, uid: "3001" }] }] }], OWNER),
    ).ok,
    true,
  );
  // other games' bindings are not gacha UIDs
  assert.equal(
    resolveOwnedGachaUid("EF_4001", listOwnedGachaUids([{ roles: [{ gameId: 1, uid: "4001" }] }], OWNER)).ok,
    false,
  );

  // findLinkedAccount: no fallback to "some other account"
  const mine = account("1001", "2001");
  assert.equal(findLinkedAccount([mine], "1001"), mine);
  assert.equal(findLinkedAccount([mine], "2001"), mine, "by role id too");
  assert.equal(findLinkedAccount([mine], "9999"), null);
  assert.equal(findLinkedAccount([mine], undefined), null);
  assert.equal(findLinkedAccount([], "1001"), null);
  assert.equal(findLinkedAccount([{ ...mine, invalid: true }], "1001"), null);

  // ---- Task 2: pure invoker rule ----
  const op = mayOperateGachaComponent;
  assert.equal(op({ clickerId: OWNER, messageInvokerId: OWNER }), true);
  assert.equal(op({ clickerId: OTHER, messageInvokerId: OWNER }), false);
  assert.equal(op({ clickerId: OTHER, messageInvokerId: OWNER, ephemeral: true }), false);
  assert.equal(op({ clickerId: OTHER, embeddedInvokerId: OWNER }), false);
  assert.equal(op({ clickerId: OWNER, embeddedInvokerId: OWNER, messageInvokerId: OTHER }), false);
  assert.equal(op({ clickerId: OWNER, embeddedInvokerId: OWNER }), true);
  assert.equal(op({ clickerId: OWNER }), false, "old public message, unknown invoker: refuse");
  assert.equal(op({ clickerId: OWNER, ephemeral: true }), true, "old ephemeral message");
  assert.equal(getMessageInvokerId({ interactionMetadata: { user: { id: OWNER } } }), OWNER);
  assert.equal(getMessageInvokerId({ interaction: { user: { id: OTHER } } }), OTHER);
  assert.equal(getMessageInvokerId({}), null);
  assert.equal(getEmbeddedInvokerId(["gacha", "sim_pull", OWNER, "p", "k", "1"]), OWNER);
  assert.equal(getEmbeddedInvokerId(["gacha", "log_load_confirm", "keep", OWNER]), OWNER);
  assert.equal(getEmbeddedInvokerId(["gacha", "log_load_confirm", "keep"]), null);
  assert.equal(getEmbeddedInvokerId(["gacha", "log_page", "EF_1"]), null);

  // ---- command level ----
  const originalGet = axios.get;
  const originalPost = axios.post;
  let networkCalls = 0;
  axios.get = (async () => {
    networkCalls++;
    throw new Error("no network in this test");
  }) as any;
  axios.post = axios.get as any;

  try {
    const db = new CustomDatabase(":memory:");
    await db.set(`${OWNER}.accounts`, [account("1001", "2001")]);
    await db.set("GACHA_LOG_EF_2001", { characterList: [], weaponList: [], info: {} });
    await db.set("GACHA_LOG_EF_7777", {
      characterList: [{ seqId: "1", gachaTs: "1", poolType: "x" }],
      weaponList: [],
      info: {},
    });
    await db.set(`GACHA_LOG_${guest}`, {
      characterList: [{ seqId: "2", gachaTs: "2" }],
      weaponList: [],
      info: {},
    });
    const logKey = (uid: string) => `GACHA_LOG_${uid}`;

    // A bystander clicks "keep" on the owner's public fingerprint prompt.
    savePending(db, pendingFingerprintKey(OTHER), { url: OFFICIAL, userId: OTHER, selectedUid: "EF_7777" });
    savePending(db, pendingFingerprintKey(OWNER), { url: OFFICIAL, userId: OWNER, selectedUid: "EF_2001" });
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OTHER },
        customId: `gacha:log_load_confirm:keep:${OWNER}`,
        isButton: () => true,
        message: {
          flags: { has: () => false },
          interactionMetadata: { user: { id: OWNER } },
        },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.deepEqual(
        calls.map((c) => c.method),
        ["reply"],
        "bystander gets one ephemeral notice and nothing else",
      );
      assert.equal(calls[0].arg.content, "gacha_component_not_yours");
      assert.notEqual(await readPending(db, pendingFingerprintKey(OWNER)), null, "owner's pending untouched");
      assert.notEqual(await readPending(db, pendingFingerprintKey(OTHER)), null, "bystander's pending untouched");
    }
    // the same click from the owner on a message without embedded id (old message)
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER },
        customId: "gacha:log_load_confirm:cancel",
        isButton: () => true,
        message: {
          flags: { has: () => false },
          interactionMetadata: { user: { id: OWNER } },
        },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "update");
      assert.equal(calls[0].arg.content, "Cancelled");
    }
    // view components: another user cannot page / switch somebody else's card
    for (const customId of [
      "gacha:log_page:EF_2001:limited_char:all:1",
      "gacha:lb_pool:all:pulls",
      "gacha:sim_pull:" + OWNER + ":p:k:1",
    ]) {
      const { interaction, calls } = fakeInteraction({
        user: { id: OTHER },
        customId,
        isButton: () => true,
        message: { flags: { has: () => false }, interactionMetadata: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.deepEqual(calls.map((c) => c.method), ["reply"], customId);
    }
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OTHER },
        customId: "gacha:log_type:EF_2001:all",
        values: ["limited_char"],
        isStringSelectMenu: () => true,
        message: { flags: { has: () => false }, interaction: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.deepEqual(calls.map((c) => c.method), ["reply"]);
    }

    // /gacha log clear account:<someone else's uid>
    for (const uid of ["EF_7777", `EF_GUEST_${OTHER}_1`, "EF_undefined"]) {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER },
        isChatInputCommand: () => true,
        options: {
          getSubcommandGroup: () => "log",
          getSubcommand: () => "clear",
          getString: (n: string) => (n === "account" ? uid : null),
        },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "reply", uid);
      assert.equal(calls[0].arg.content, "gacha_uid_not_owned", uid);
      assert.equal(calls[0].arg.components, undefined, "no confirm button offered");
    }
    // own uid in the other key form is accepted and gets a confirm button
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER },
        isChatInputCommand: () => true,
        options: {
          getSubcommandGroup: () => "log",
          getSubcommand: () => "clear",
          getString: (n: string) => (n === "account" ? "EF_CN_2001" : n === "start_time" ? "2025-01-01T10:00:00" : null),
        },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "reply");
      const id = calls[0].arg.components[0].components[0].data.custom_id as string;
      assert.match(id, /^gacha:log_clear_confirm:EF_CN_2001:2025-01-01T10%3A00%3A00:$/);
    }

    // clear confirm with a forged uid: ownership is re-checked, nothing is deleted
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER },
        customId: "gacha:log_clear_confirm:EF_7777::",
        isButton: () => true,
        message: { flags: { has: () => true }, interactionMetadata: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "update");
      assert.equal(calls[0].arg.content, "gacha_uid_not_owned");
      assert.notEqual(await db.get(logKey("EF_7777")), null, "victim's log still there");
    }
    // clear confirm on the own guest key does delete it
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER },
        customId: `gacha:log_clear_confirm:${guest}::`,
        isButton: () => true,
        message: { flags: { has: () => true }, interactionMetadata: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "deferUpdate");
      assert.equal(await db.get(logKey(guest)), null);
    }

    // migrate: foreign source guest, and foreign target
    await db.set(`GACHA_LOG_EF_GUEST_${OTHER}_5`, {
      characterList: [{ seqId: "5", gachaTs: "5" }],
      weaponList: [],
      info: { lang: "tw" },
    });
    for (const [source, target] of [
      [`EF_GUEST_${OTHER}_5`, "EF_2001"],
      ["EF_7777", "EF_2001"],
      [`EF_GUEST_${OWNER}_9`, "EF_7777"],
    ]) {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER, displayName: "Owner" },
        customId: `gacha:log_migrate_select:${source}`,
        values: [target],
        isStringSelectMenu: () => true,
        message: { flags: { has: () => true }, interactionMetadata: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.deepEqual(calls.map((c) => c.method), ["deferReply", "editReply"], source);
      assert.equal(calls[1].arg.content, "gacha_uid_not_owned", `${source} -> ${target}`);
    }
    assert.notEqual(await db.get(`GACHA_LOG_EF_GUEST_${OTHER}_5`), null, "other user's guest log untouched");
    assert.equal((await db.get<any>("GACHA_LOG_EF_2001")).characterList.length, 0);

    // recover into a uid that is not the clicker's
    await db.set("GACHA_LOG_EF_undefined", { characterList: [{ seqId: "8", gachaTs: "8" }], weaponList: [], info: { lang: "tw" } });
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER, displayName: "Owner" },
        customId: "gacha:log_recover:EF_7777",
        isButton: () => true,
        message: { flags: { has: () => true }, interactionMetadata: { user: { id: OWNER } } },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "update");
      assert.equal(calls[0].arg.content, "gacha_uid_not_owned");
      assert.notEqual(await db.get("GACHA_LOG_EF_undefined"), null);
    }

    // load into someone else's uid (customId of the modal): refused, no request
    for (const customId of ["gacha:log_load:EF_7777", "gacha:log_load:EF_GUEST_" + OTHER + "_5"]) {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER, displayName: "Owner", displayAvatarURL: () => "" },
        customId,
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => OFFICIAL },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "deferReply");
      const reply = calls.find((c) => c.method === "followUp");
      assert.equal(reply?.arg.content, "gacha_uid_not_owned", customId);
    }
    assert.equal(networkCalls, 0, "ownership refusals never reach the network");

    // load with a foreign host: refused before anything is stored or requested
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER, displayName: "Owner", displayAvatarURL: () => "" },
        customId: "gacha:log_load",
        isModalSubmit: () => true,
        fields: {
          getTextInputValue: () =>
            "https://ef-webview.gryphline.com.evil.com/x?token=tok&server_id=2",
        },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.equal(calls[0].method, "deferReply", "modal submit is acknowledged first");
      assert.equal(calls[calls.length - 1].method, "editReply");
      assert.equal(calls[calls.length - 1].arg.content, "gacha_import_url_refused");
      assert.equal(await readPending(db, pendingUrlKey(OWNER)), null, "nothing stored");
      assert.equal(networkCalls, 0);
    }
    // a good URL: acknowledged first, then pending stored encrypted and a menu shown
    {
      const { interaction, calls } = fakeInteraction({
        user: { id: OWNER, displayName: "Owner", toString: () => `<@${OWNER}>`, displayAvatarURL: () => "" },
        customId: "gacha:log_load",
        isModalSubmit: () => true,
        fields: { getTextInputValue: () => OFFICIAL },
      });
      await gachaCommand.execute({}, interaction, tr, db);
      assert.deepEqual(calls.map((c) => c.method), ["deferReply", "editReply"]);
      assert.equal((await readPending<{ url: string }>(db, pendingUrlKey(OWNER)))?.url, OFFICIAL);
      const raw = (db as any).db
        .prepare("SELECT json FROM json WHERE ID = ?")
        .get(pendingUrlKey(OWNER)).json as string;
      assert.ok(!raw.includes("tok"), "token is not stored in the clear");
      assert.ok(JSON.parse(raw).exp > Date.now(), "stored with a TTL");
    }

    // ---- Task 6: pending rows ----
    {
      const key = pendingUrlKey("legacy-user");
      await db.set(key, "https://ef-webview.gryphline.com/x?token=old&server_id=2"); // legacy row
      assert.equal(await readPending(db, key), null);
      assert.equal(await db.get(key), null, "legacy row deleted when met");

      const k2 = pendingFingerprintKey("expiring");
      savePending(db, k2, { url: "u" });
      assert.deepEqual(await readPending(db, k2), { url: "u" });
      const row = JSON.parse(((db as any).db.prepare("SELECT json FROM json WHERE ID = ?").get(k2) as any).json);
      assert.ok(row.exp - Date.now() <= PENDING_GACHA_TTL_MS && row.exp - Date.now() > PENDING_GACHA_TTL_MS - 5000);
      await db.set(k2, { v: row.v, exp: Date.now() - 1 });
      assert.equal(await readPending(db, k2), null, "expired");
      assert.equal(await db.get(k2), null);

      const k3 = pendingUrlKey("garbled");
      db.setWithTtl(k3, "not-decryptable:aa:bb", 60000);
      assert.equal(await readPending(db, k3), null);
      assert.equal(await db.get(k3), null, "unreadable row deleted");
    }

    // ---- Task 4: what the user is told ----
    {
      const lines = describeIncompleteFetches(
        [
          { poolType: "E_CharacterGachaPoolType_Joint", reason: "timeout" },
          { poolType: "WeaponPool", poolId: "w2", reason: "code 7" },
          { poolType: "WeaponPool", reason: "pool list: code 500" },
        ],
        tr,
      );
      assert.equal(lines.length, 3);
      assert.match(lines[0], /Joint.*timeout/);
      assert.match(lines[1], /gacha_import_part_weapon_pool.*w2.*code 7/);
      assert.match(lines[2], /gacha_import_part_weapon_list/);
    }
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }

  console.log("gacha ownership / component / pending tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
