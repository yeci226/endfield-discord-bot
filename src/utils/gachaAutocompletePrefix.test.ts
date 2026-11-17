import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";

async function main() {
  const db = new CustomDatabase(":memory:");
  const userId = "123456789012345678";
  const prefix = `GACHA_LOG_EF_GUEST_${userId}_`;
  const expectedId = `${prefix}1700000000000`;

  await db.set(expectedId, { info: { nickname: "我的訪客紀錄" } });
  await db.set(
    `GACHA_LOG_EF_GUEST_${userId}X1700000000000`,
    { info: { nickname: "不得匹配" } },
  );
  await db.set(
    "GACHA_LOG_EF_GUEST_999999999999999999_1700000000000",
    { info: { nickname: "其他使用者" } },
  );

  const findByGlobPrefix = (db as any).findFieldByGlobPrefix;
  assert.equal(
    typeof findByGlobPrefix,
    "function",
    "database must expose an indexed literal-prefix lookup for autocomplete",
  );
  const matches = findByGlobPrefix.call(db, prefix, "$.info.nickname");
  assert.deepEqual(matches, [{ id: expectedId, field: "我的訪客紀錄" }]);
  assert.throws(
    () => findByGlobPrefix.call(db, `${prefix}*`, "$.info.nickname"),
    /safe literal prefix/i,
  );

  console.log("literal-prefix gacha log lookup tests passed");
}

void main();
