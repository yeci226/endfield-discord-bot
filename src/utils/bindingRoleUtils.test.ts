import assert from "node:assert/strict";
import {
  findPrimaryBindingRole,
  normalizeBindingRoles,
  resolveBindingUid,
  selectAccountByIndex,
} from "./bindingRoleUtils";

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
    gameId: 3,
    uid: "837903459",
    nickName: "",
    channelMasterId: "6",
    channelName: "官服",
    gameName: "明日方舟：终末地",
    roles: [],
    defaultRole: null,
  },
];

const endfield = findPrimaryBindingRole(productionBindings, 3);
assert.equal(endfield?.binding.gameId, 3);
assert.deepEqual(endfield?.role, {
  roleId: "837903459",
  serverId: "6",
  nickname: "837903459",
  level: 0,
  serverName: "官服",
});
assert.equal(
  resolveBindingUid(endfield, "7045530141380"),
  "837903459",
  "Endfield binding uid must take precedence over the SKPort account id",
);

const arknights = findPrimaryBindingRole(productionBindings, 1);
assert.equal(arknights?.binding.gameId, 1);
assert.equal(arknights?.role.roleId, "515336528");
assert.equal(arknights?.role.nickname, "星星#6271");

const defaultRole = {
  roleId: "nested-role",
  serverId: "2",
  nickname: "Default Endfield",
};
assert.deepEqual(
  normalizeBindingRoles({
    gameId: "3",
    uid: "binding-uid",
    roles: [],
    defaultRole,
  }),
  [defaultRole],
);

const nestedRole = {
  roleId: "preferred-role",
  serverId: "3",
  nickname: "Preferred Endfield",
};
assert.deepEqual(
  normalizeBindingRoles({
    gameId: 3,
    uid: "binding-uid",
    roles: [nestedRole],
    defaultRole,
  }),
  [nestedRole],
);

assert.equal(findPrimaryBindingRole(productionBindings, 2), null);

const wrappedBindings = [
  {
    appCode: "skland",
    appName: "森空島",
    bindingList: productionBindings,
  },
];
assert.equal(
  findPrimaryBindingRole(wrappedBindings, 3)?.role?.roleId,
  "837903459",
  "SKPort app wrappers must be flattened before selecting the Endfield role",
);

const multipleAccounts = [{ id: "first" }, { id: "selected" }];
assert.equal(selectAccountByIndex(multipleAccounts, "1")?.id, "selected");
assert.equal(selectAccountByIndex(multipleAccounts, undefined)?.id, "first");
assert.equal(selectAccountByIndex(multipleAccounts, "invalid")?.id, "first");
