import assert from "node:assert/strict";
import { normalizeAttendanceBindings } from "./attendanceBindingUtils";

const bindings = [
  {
    gameId: "3",
    uid: "837903459",
    nickName: "user_1599137630069",
  },
  {
    gameId: 1,
    uid: "arknights-account",
    roles: [
      {
        roleId: "arknights-role",
        serverId: "1",
        nickname: "星星#6271",
      },
    ],
  },
];

const endfield = normalizeAttendanceBindings(bindings, "endfield");
assert.deepEqual(endfield, [
  {
    gameId: 3,
    roles: [
      {
        roleId: "837903459",
        serverId: "",
        nickname: "user_1599137630069",
        level: 0,
        serverName: "-",
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
  both.map((binding) => binding.gameId),
  [3, 1],
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
