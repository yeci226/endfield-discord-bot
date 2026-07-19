import assert from "node:assert/strict";
import { normalizeAttendanceBindings } from "./attendanceBindingUtils";

const bindings = [
  {
    gameId: 1,
    uid: "515336528",
    nickName: "星星#6271",
    channelMasterId: "6",
    channelName: "繁中服",
    roles: [],
    defaultRole: null,
  },
  {
    gameId: "3",
    uid: "837903459",
    nickName: "",
    channelMasterId: "6",
    channelName: "官服",
    roles: [],
    defaultRole: null,
  },
];

const endfield = normalizeAttendanceBindings(bindings, "endfield");
assert.deepEqual(endfield, [
  {
    gameId: 3,
    roles: [
      {
        roleId: "837903459",
        serverId: "6",
        nickname: "837903459",
        level: 0,
        serverName: "官服",
      },
    ],
  },
]);

const arknights = normalizeAttendanceBindings(bindings, "arknights");
assert.equal(arknights.length, 1);
assert.equal(arknights[0].gameId, 1);
assert.equal(arknights[0].roles[0].nickname, "星星#6271");

const both = normalizeAttendanceBindings(bindings, "both");
assert.deepEqual(
  both.map((binding: { gameId: number }) => binding.gameId),
  [1, 3],
);

const nested = normalizeAttendanceBindings(
  [
    {
      bindingList: [
        {
          gameId: 3,
          uid: "binding-uid",
          defaultRole: {
            roleId: "nested-role",
            serverId: "2",
            nickname: "Nested Endfield",
          },
        },
      ],
    },
  ],
  "endfield",
);
assert.equal(nested[0].roles[0].roleId, "nested-role");
