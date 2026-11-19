import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";
import { moveDailyNotifyChannels } from "./moveDailyNotify";

async function main() {
  const db = new CustomDatabase(":memory:");
  await db.set("autoDaily.1", { channelId: "c1", time: 3, extra: { keep: true } });
  await db.set("autoDaily.2", { channelId: "c2", time: 5 });
  await db.set("autoDaily.3", { channelId: "other-guild", time: 7 });
  await db.set("autoDaily.4", { channelId: "target", time: 9 });
  await db.set("autoDaily.5", { time: 11 }); // DM user: no channel
  await db.set("autoDailyState.1", { channelId: "c1" }); // not an auto-daily row
  const guild = new Set(["c1", "c2", "target"]);

  assert.equal(moveDailyNotifyChannels(db, guild, "target"), 2);
  assert.deepEqual(await db.get("autoDaily.1"), { channelId: "target", time: 3, extra: { keep: true } });
  assert.deepEqual(await db.get("autoDaily.2"), { channelId: "target", time: 5 });
  assert.deepEqual(await db.get("autoDaily.3"), { channelId: "other-guild", time: 7 });
  assert.deepEqual(await db.get("autoDaily.5"), { time: 11 });
  assert.deepEqual(await db.get("autoDailyState.1"), { channelId: "c1" });
  assert.equal(moveDailyNotifyChannels(db, guild, "target"), 0, "second run changes nothing");
  assert.equal(moveDailyNotifyChannels(db, new Set(), "x"), 0);

  console.log("moveDailyNotify tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
