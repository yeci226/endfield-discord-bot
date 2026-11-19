import assert from "node:assert/strict";
import {
  ARKNIGHTS_GAME_ID,
  ENDFIELD_GAME_ID,
  gameIdsForScope,
  getPrimaryBindingRoleForGame,
  normalizeBindingRoles,
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

// --- Endfield: roles [] + defaultRole null -> synthesized from the binding -----
{
  const ef = normalizeBindingRoles(productionBindings, [3]);
  assert.equal(ef.length, 1);
  assert.equal(ef[0].gameId, 3);
  assert.equal(ef[0].roleId, "837903459");
  assert.equal(ef[0].serverId, "6");
  assert.equal(ef[0].nickname, "837903459", "falls back to uid when nickName is empty");
  assert.equal(ef[0].channelMasterId, "6");
  assert.equal(ef[0].synthesized, true);
  assert.equal((ef[0].raw as any).serverName, "官服");
  assert.equal((ef[0].raw as any).level, 0);
}

// --- Mixed AK-first account: gameId filter decides ---------------------------
{
  assert.equal(getPrimaryBindingRoleForGame(productionBindings, 3)?.gameId, 3);
  assert.equal(getPrimaryBindingRoleForGame(productionBindings, 3)?.roleId, "837903459");
  assert.equal(getPrimaryBindingRoleForGame(productionBindings, 1)?.roleId, "515336528");
  // order of output follows the order of the bindings, not of gameIds
  assert.deepEqual(
    normalizeBindingRoles(productionBindings, [3, 1]).map((r) => r.gameId),
    [1, 3],
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
  const wrapped = [{ appCode: "skport", bindingList: productionBindings }];
  assert.equal(getPrimaryBindingRoleForGame(wrapped, 3)?.roleId, "837903459");
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

console.log("bindingRoles checks passed");
