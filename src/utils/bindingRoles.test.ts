import assert from "node:assert/strict";
import {
  ARKNIGHTS_GAME_ID,
  ENDFIELD_GAME_ID,
  gameIdsForScope,
  resolveEndfieldTarget,
  getPrimaryBindingRoleForGame,
  normalizeBindingRoles,
  findRoleByKey,
  listEndfieldRoles,
  roleKey,
  roleSelectOptions,
} from "./bindingRoles";

assert.equal(ENDFIELD_GAME_ID, 3);
assert.equal(ARKNIGHTS_GAME_ID, 1);

// Production-shaped fixture from the reverted commit 2dd055e (AK first, both roles empty).
const productionBindings = [
  {
    gameId: 1,
    uid: "515336528",
    nickName: "星星#6271",
    channelMasterId: "6",
    channelName: "繁中服",
    gameName: "明日方舟",
    roles: [],
    defaultRole: null,
  },
  {
    gameId: "3",
    uid: "837903459",
    nickName: "",
    channelMasterId: "6",
    channelName: "官服",
    gameName: "明日方舟：终末地",
    roles: [],
    defaultRole: null,
  },
];

// The Arknights synthesis that daily.ts / AutoDailyService.ts do today (copied verbatim,
// the new util must produce an identical role object).
function legacyArknightsRole(entry: any) {
  return {
    roleId: String(entry?.uid || ""),
    serverId: String(entry?.channelMasterId || ""),
    nickname: String(entry?.nickName || entry?.uid || "Arknights"),
    level: 0,
    serverName: String(entry?.channelName || entry?.gameName || "-"),
  };
}

// --- Arknights: byte-for-byte what the old code produced -------------------
{
  const ak = normalizeBindingRoles(productionBindings, [1]);
  assert.equal(ak.length, 1);
  assert.deepEqual(ak[0].raw, legacyArknightsRole(productionBindings[0]));
  assert.equal(ak[0].gameId, 1);
  assert.equal(ak[0].roleId, "515336528");
  assert.equal(ak[0].serverId, "6");
  assert.equal(ak[0].nickname, "星星#6271");
  assert.equal(ak[0].channelMasterId, "6");
  assert.equal(ak[0].synthesized, true);

  // nickname fallbacks of the old code
  const noNick = { gameId: 1, uid: "42", roles: [] };
  assert.deepEqual(
    normalizeBindingRoles([noNick], [1])[0].raw,
    legacyArknightsRole(noNick),
  );
  // The old code also emitted a role with roleId "" for a nickName-only binding; that role
  // could never be used for an API call, so it is deliberately not emitted any more.
  const onlyNick = { gameId: 1, nickName: "x", roles: [] };
  assert.equal(legacyArknightsRole(onlyNick).roleId, "");
  assert.deepEqual(normalizeBindingRoles([onlyNick], [1]), []);
}

// --- Endfield: roles [] + defaultRole null -> NO role (2026-11-19 production measurement:
// binding.uid !== roles[0].roleId in all 7,216 role-bearing bindings, so a role built from
// the binding would send a wrong roleId/serverId).
{
  assert.deepEqual(normalizeBindingRoles(productionBindings, [3]), []);
  assert.equal(getPrimaryBindingRoleForGame(productionBindings, 3), null);
  // nickName present does not change that
  assert.deepEqual(
    normalizeBindingRoles([{ ...productionBindings[1], nickName: "Someone" }], [3]),
    [],
  );
  // a defaultRole is still honoured
  assert.equal(
    getPrimaryBindingRoleForGame([{ ...productionBindings[1], defaultRole: { roleId: "d", serverId: "2" } }], 3)?.roleId,
    "d",
  );
}

// Mixed AK-first account whose Endfield binding has a real role.
const efRole = { roleId: "6600112233", serverId: "2", nickname: "Endmin", level: 30, serverName: "Asia" };
const mixedBindings = [productionBindings[0], { ...productionBindings[1], roles: [efRole] }];

// --- Mixed AK-first account: gameId filter decides ---------------------------
{
  assert.equal(getPrimaryBindingRoleForGame(mixedBindings, 3)?.gameId, 3);
  assert.equal(getPrimaryBindingRoleForGame(mixedBindings, 3)?.roleId, "6600112233");
  assert.equal(getPrimaryBindingRoleForGame(mixedBindings, 3)?.bindingUid, "837903459");
  assert.equal(getPrimaryBindingRoleForGame(mixedBindings, 1)?.roleId, "515336528");
  // order of output follows the order of the bindings, not of gameIds
  assert.deepEqual(
    normalizeBindingRoles(mixedBindings, [3, 1]).map((r) => r.gameId),
    [1, 3],
  );
  // `both` with only the Arknights role present yields just that one
  assert.deepEqual(
    normalizeBindingRoles(productionBindings, [1, 3]).map((r) => r.gameId),
    [1],
  );
}

// --- No binding for the game -> null / [] ------------------------------------
{
  assert.equal(getPrimaryBindingRoleForGame(productionBindings, 2), null);
  assert.equal(getPrimaryBindingRoleForGame([productionBindings[0]], 3), null);
  assert.equal(getPrimaryBindingRoleForGame([], 3), null);
  assert.equal(getPrimaryBindingRoleForGame(null, 3), null);
  assert.equal(getPrimaryBindingRoleForGame(undefined, 3), null);
  assert.deepEqual(normalizeBindingRoles("nope" as any, [3]), []);
  assert.deepEqual(normalizeBindingRoles([null, 5, "x"] as any, [3]), []);
}

// --- Existing roles are returned verbatim; raw is the stored object ----------
{
  const stored = {
    roleId: "role-1",
    serverId: "2",
    nickname: "Endmin",
    level: 41,
    serverName: "Asia",
  };
  const binding = { gameId: 3, uid: "binding-uid", nickName: "other", roles: [stored] };
  const [r] = normalizeBindingRoles([binding], [3]);
  assert.equal(r.roleId, "role-1");
  assert.equal(r.serverId, "2");
  assert.equal(r.nickname, "Endmin");
  assert.equal(r.synthesized, false);
  assert.equal(r.raw, stored, "raw must be the very same stored object");
  assert.equal(r.bindingUid, "binding-uid");
}

// --- Several roles keep their order; falsy entries are skipped ---------------
{
  const roles = [
    { roleId: "a", serverId: "1", nickname: "A" },
    null,
    { roleId: "b", serverId: "2", nickname: "B" },
  ];
  const out = normalizeBindingRoles([{ gameId: 3, uid: "u", roles }], [3]);
  assert.deepEqual(out.map((r) => r.roleId), ["a", "b"]);
}

// --- roles [] with a defaultRole: newly resolved (old code ignored it) -------
{
  const defaultRole = { roleId: "d1", serverId: "3", nickName: "Dflt", level: 7 };
  const [r] = normalizeBindingRoles(
    [{ gameId: 3, uid: "u", roles: [], defaultRole }],
    [3],
  );
  assert.equal(r.roleId, "d1");
  assert.equal(r.nickname, "Dflt", "role.nickName is accepted when nickname is absent");
  assert.equal(r.raw, defaultRole);
  assert.equal(r.synthesized, false);
}

// --- role without roleId falls back to role.uid then binding.uid; no id -> skipped
{
  const out = normalizeBindingRoles(
    [
      {
        gameId: 3,
        uid: "bu",
        roles: [{ uid: "ru", serverId: "1" }, { serverId: "1" }, {}],
      },
    ],
    [3],
  );
  assert.deepEqual(out.map((r) => r.roleId), ["ru", "bu", "bu"]);
  const none = normalizeBindingRoles([{ gameId: 3, roles: [{ serverId: "1" }] }], [3]);
  assert.deepEqual(none, [], "a role with no id anywhere must not be emitted");
}

// --- SKPort app wrapper (bindingList) is flattened ---------------------------
{
  const wrapped = [{ appCode: "skport", bindingList: mixedBindings }];
  assert.equal(getPrimaryBindingRoleForGame(wrapped, 3)?.roleId, "6600112233");
  assert.equal(getPrimaryBindingRoleForGame(wrapped, 1)?.roleId, "515336528");
}

// --- A binding with neither roles nor uid/nickName yields nothing ------------
{
  assert.deepEqual(
    normalizeBindingRoles([{ gameId: 3, roles: [], defaultRole: null }], [3]),
    [],
  );
}

// --- Scope helper --------------------------------------------------------------
assert.deepEqual(gameIdsForScope("endfield"), [3]);
assert.deepEqual(gameIdsForScope("arknights"), [1]);
assert.deepEqual(gameIdsForScope("both"), [1, 3]);

// --- resolveEndfieldTarget: zero accounts, Arknights-only, picker -----------------
{
  const akOnly = { info: { id: "ak" }, roles: [productionBindings[0]] };
  const both = { info: { id: "both" }, roles: mixedBindings };
  const efNoRole = { info: { id: "efnr" }, roles: [productionBindings[1]] };
  assert.deepEqual(resolveEndfieldTarget([]), { ok: false, reason: "no_account" });
  assert.deepEqual(resolveEndfieldTarget(null), { ok: false, reason: "no_account" });
  assert.deepEqual(resolveEndfieldTarget([akOnly]), { ok: false, reason: "no_endfield_role" });
  assert.deepEqual(resolveEndfieldTarget([akOnly], 0), { ok: false, reason: "no_endfield_role" });
  assert.deepEqual(resolveEndfieldTarget([akOnly, both], 2), { ok: false, reason: "account_not_found" });
  assert.deepEqual(resolveEndfieldTarget([akOnly, both], -1), { ok: false, reason: "account_not_found" });
  assert.deepEqual(resolveEndfieldTarget([akOnly, both], 1.5), { ok: false, reason: "account_not_found" });
  const auto = resolveEndfieldTarget([akOnly, both]);
  assert.ok(auto.ok && auto.accountIndex === 1 && auto.role.roleId === "6600112233");
  // an account bound to Endfield without any role has no Endfield role
  assert.deepEqual(resolveEndfieldTarget([efNoRole]), { ok: false, reason: "no_endfield_role" });
  const explicit = resolveEndfieldTarget([both, akOnly], 0);
  assert.ok(explicit.ok && explicit.accountIndex === 0);
  assert.deepEqual(resolveEndfieldTarget([both, akOnly], 1), { ok: false, reason: "no_endfield_role" });
}

// --- listEndfieldRoles / role picker helpers (moved from the removed endfieldRole.ts) ---
const role = (id: string, server = "1", extra: any = {}) => ({ roleId: id, serverId: server, nickname: `N${id}`, level: 5, serverName: "Asia", ...extra });

// Normal bindings, flat and nested bindingList shapes.
{
  const accounts = [
    { info: { id: "100", nickname: "main" }, roles: [{ gameId: 3, uid: "u1", roles: [role("r1"), role("r2", "2")] }] },
    { info: { id: "200" }, roles: [{ bindingList: [{ gameId: 3, roles: [role("r3")] }] }] },
  ];
  const list = listEndfieldRoles(accounts);
  assert.deepEqual(list.map((r) => [r.accountIndex, r.roleId, r.serverId]), [[0, "r1", "1"], [0, "r2", "2"], [1, "r3", "1"]]);
  assert.equal(list[0].accountLabel, "main");
  assert.equal(list[2].accountLabel, "200");
  assert.equal(list[0].skUserId, "100", "the userId sent to the API stays the SKPORT account id");
  assert.equal(list[0].level, 5);
  assert.equal(list[0].serverName, "Asia");
}

// skUserId falls back to the binding uid only when the account has no id (old behaviour).
assert.equal(listEndfieldRoles([{ info: {}, roles: [{ gameId: 3, uid: "bu", roles: [role("r")] }] }])[0].skUserId, "bu");

// Arknights (gameId 1) is ignored; AK-first account still yields the Endfield role.
{
  const accounts = [{ info: { id: "1" }, roles: [{ gameId: 1, uid: "ak", roles: [role("ak1")] }, { gameId: 3, roles: [role("ef1")] }] }];
  assert.deepEqual(listEndfieldRoles(accounts).map((r) => r.roleId), ["ef1"]);
  assert.deepEqual(listEndfieldRoles([{ info: { id: "1" }, roles: [{ gameId: 1, uid: "ak", nickName: "x", roles: [] }] }]), []);
}

// roles: [] + defaultRole null -> no role (never synthesized for Endfield).
assert.deepEqual(
  listEndfieldRoles([{ info: { id: "9" }, roles: [{ gameId: 3, uid: "7777", nickName: "Synth", channelMasterId: "1", roles: [], defaultRole: null }] }]),
  [],
);

// defaultRole only.
assert.equal(listEndfieldRoles([{ info: { id: "9" }, roles: [{ gameId: 3, defaultRole: role("d1") }] }])[0].roleId, "d1");

// Empty / broken input never throws.
assert.deepEqual(listEndfieldRoles([]), []);
assert.deepEqual(listEndfieldRoles(null), []);
assert.deepEqual(listEndfieldRoles([{ info: {}, roles: undefined }, null as any]), []);

// Duplicates inside one account collapse.
assert.equal(listEndfieldRoles([{ info: { id: "1" }, roles: [{ gameId: 3, roles: [role("a")] }, { gameId: 3, roles: [role("a")] }] }]).length, 1);

// Keys and select options.
{
  const list = listEndfieldRoles([{ info: { id: "1", nickname: "acc" }, roles: [{ gameId: 3, roles: [role("a"), role("b")] }] }]);
  assert.equal(findRoleByKey(list, roleKey(list[1]))?.roleId, "b");
  assert.equal(findRoleByKey(list, "nope"), undefined);
  const opts = roleSelectOptions(list, roleKey(list[1]));
  assert.deepEqual(opts.map((o) => o.default), [false, true]);
  assert.equal(opts[0].emoji, "1️⃣");
  assert.equal(opts[0].label, "Na");
  assert.equal(opts[0].description, "Asia · acc");
  const many = Array.from({ length: 40 }, (_, i) => ({ ...list[0], roleId: `r${i}` }));
  assert.equal(roleSelectOptions(many, "").length, 25);
}

console.log("bindingRoles checks passed");
