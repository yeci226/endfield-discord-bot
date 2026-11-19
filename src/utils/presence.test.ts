import assert from "node:assert/strict";
import { createPresenceUpdater } from "./presence";

async function main() {
  let total = 10;
  let clock = 0;
  const pushed: number[] = [];
  let failPush = false;
  const tick = createPresenceUpdater({
    getTotal: async () => total,
    push: async (n) => {
      if (failPush) throw new Error("cluster booting");
      pushed.push(n);
    },
    repushEveryMs: 1000,
    now: () => clock,
  });
  assert.equal(await tick(), "pushed");
  assert.equal(await tick(), "skipped", "unchanged total is not pushed again");
  total = 11;
  assert.equal(await tick(), "pushed");
  clock = 5000;
  assert.equal(await tick(), "pushed", "periodic re-push covers respawned clusters");
  total = 12;
  failPush = true;
  assert.equal(await tick(), "failed");
  failPush = false;
  assert.equal(await tick(), "pushed", "a failed push is retried on the next tick");
  assert.deepEqual(pushed, [10, 11, 11, 12]);

  const broken = createPresenceUpdater({
    getTotal: async () => {
      throw new Error("no clusters");
    },
    push: async () => {},
  });
  assert.equal(await broken(), "failed");
  console.log("presence tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
