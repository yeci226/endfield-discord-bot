import assert from "node:assert/strict";
import { findRoleByKey, listEndfieldRoles, roleKey, roleSelectOptions } from "./endfieldRole";

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
  assert.equal(list[0].skUserId, "100");
}

// Arknights (gameId 1) is ignored; AK-first account still yields the Endfield role.
{
  const accounts = [{ info: { id: "1" }, roles: [{ gameId: 1, uid: "ak", roles: [role("ak1")] }, { gameId: 3, roles: [role("ef1")] }] }];
  assert.deepEqual(listEndfieldRoles(accounts).map((r) => r.roleId), ["ef1"]);
  assert.deepEqual(listEndfieldRoles([{ info: { id: "1" }, roles: [{ gameId: 1, uid: "ak", nickName: "x", roles: [] }] }]), []);
}

// roles: [] + defaultRole null -> synthesized from the binding itself.
{
  const accounts = [{ info: { id: "9" }, roles: [{ gameId: 3, uid: "7777", nickName: "Synth", channelMasterId: "1", channelName: "Asia", roles: [], defaultRole: null }] }];
  const [r] = listEndfieldRoles(accounts);
  assert.equal(r.roleId, "7777");
  assert.equal(r.serverId, "1");
  assert.equal(r.nickname, "Synth");
  assert.equal(r.serverName, "Asia");
}

// defaultRole only.
assert.equal(listEndfieldRoles([{ info: { id: "9" }, roles: [{ gameId: 3, defaultRole: role("d1") }] }])[0].roleId, "d1");

// Empty / broken input never throws.
assert.deepEqual(listEndfieldRoles([]), []);
assert.deepEqual(listEndfieldRoles(null), []);
assert.deepEqual(listEndfieldRoles([{ info: {}, roles: undefined }, null as any]), []);
assert.deepEqual(listEndfieldRoles([{ info: { id: "1" }, roles: [{ gameId: 3, roles: [], defaultRole: null }] }]), []);

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
  assert.equal(opts[0].description, "Asia · acc");
  const many = Array.from({ length: 40 }, (_, i) => ({ ...list[0], roleId: `r${i}` }));
  assert.equal(roleSelectOptions(many, "").length, 25);
}

console.log("endfieldRole tests passed");
