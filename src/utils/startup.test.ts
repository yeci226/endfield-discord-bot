import assert from "node:assert/strict";
import { StartupHooks } from "./startup";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeLogger() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    info: (m: string) => void infos.push(m),
    error: (m: string) => void errors.push(m),
  };
}

async function main() {
  // non-primary runs nothing
  {
    const hooks = new StartupHooks(makeLogger());
    let calls = 0;
    hooks.onPrimary("a", () => void calls++);
    hooks.every("b", 10, () => void calls++);
    await hooks.run(false);
    await sleep(50);
    assert.equal(calls, 0);
    hooks.onPrimary("late", () => void calls++); // ignored after run(false)
    await sleep(10);
    assert.equal(calls, 0);
    hooks.stop();
  }

  // primary: in order; throwing hook logged with name, next still runs
  {
    const logger = makeLogger();
    const hooks = new StartupHooks(logger);
    const order: string[] = [];
    hooks.onPrimary("one", () => void order.push("one"));
    hooks.onPrimary("boom", () => {
      throw new Error("kaboom");
    });
    hooks.onPrimary("rejects", async () => {
      throw new Error("async kaboom");
    });
    hooks.onPrimary("two", async () => void order.push("two"));
    await hooks.run(true);
    assert.deepEqual(order, ["one", "two"]);
    assert.equal(logger.errors.length, 2);
    assert.ok(logger.errors[0].includes("boom"));
    assert.ok(logger.errors[1].includes("rejects"));
    hooks.stop();
  }

  // every(): throwing first call does not stop later ticks
  {
    const hooks = new StartupHooks(makeLogger());
    let calls = 0;
    hooks.every("flaky", 20, () => {
      calls++;
      if (calls === 1) throw new Error("first fails");
    });
    await hooks.run(true);
    await sleep(110);
    assert.ok(calls >= 3, `expected >= 3 calls, got ${calls}`);
    hooks.stop();
  }

  // every(): never overlaps itself
  {
    const hooks = new StartupHooks(makeLogger());
    let running = 0;
    let maxRunning = 0;
    hooks.every("slow", 10, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(50);
      running--;
    });
    await hooks.run(true);
    await sleep(200);
    hooks.stop();
    await sleep(60);
    assert.equal(maxRunning, 1);
  }

  // late registration after run(true) starts immediately
  {
    const hooks = new StartupHooks(makeLogger());
    await hooks.run(true);
    let late = 0;
    hooks.onPrimary("late", () => void late++);
    await sleep(5);
    assert.equal(late, 1);
    let ticks = 0;
    hooks.every("lateEvery", 15, () => void ticks++);
    await sleep(60);
    assert.ok(ticks >= 2, `expected >= 2 ticks, got ${ticks}`);
    hooks.stop();
  }

  // duplicate name throws
  {
    const hooks = new StartupHooks(makeLogger());
    hooks.onPrimary("dup", () => {});
    assert.throws(() => hooks.every("dup", 10, () => {}), /already registered/);
    assert.throws(() => hooks.onPrimary("dup", () => {}), /already registered/);
  }

  // stop(): no further calls after stop()
  {
    const hooks = new StartupHooks(makeLogger());
    let calls = 0;
    hooks.every("tick", 10, () => void calls++);
    await hooks.run(true);
    await sleep(45);
    hooks.stop();
    const atStop = calls;
    assert.ok(atStop >= 1);
    await sleep(50);
    assert.equal(calls, atStop);
  }

  console.log("startup tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
