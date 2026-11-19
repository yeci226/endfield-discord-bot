import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createKeyThrottle,
  describeError,
  installProcessErrorHandlers,
} from "./processErrors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // describeError is null-safe
  assert.equal(describeError(undefined).message, "undefined");
  assert.equal(describeError(null).message, "null");
  assert.equal(describeError("boom").message, "boom");
  assert.equal(describeError({ message: "m" }).message, "m");
  assert.equal(describeError(new Error("e")).message, "e");
  assert.match(describeError(new Error("e")).stack, /Error: e/);

  // throttle: one per window per key
  const allow = createKeyThrottle(30_000, 3);
  assert.equal(allow("a", 0), true);
  assert.equal(allow("a", 29_999), false);
  assert.equal(allow("b", 100), true);
  assert.equal(allow("a", 30_000), true);
  for (const k of ["c", "d", "e", "f"]) allow(k, 31_000);

  const proc = new EventEmitter();
  const sent: any[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  let clock = 0;
  installProcessErrorHandlers({
    logger: { error: (...a: unknown[]) => void logs.push(a.map(String).join(" ")) },
    webhook: { send: async (p) => void sent.push(p) },
    proc,
    exit: (c) => void exits.push(c),
    exitDelayMs: 20,
    now: () => clock,
  });

  // unhandledRejection: reported once per 30 s per message, never exits, null-safe
  proc.emit("unhandledRejection", undefined);
  proc.emit("unhandledRejection", undefined);
  proc.emit("unhandledRejection", new Error("same"));
  proc.emit("unhandledRejection", new Error("same"));
  await sleep(40);
  assert.equal(sent.length, 2);
  assert.deepEqual(exits, []);
  clock = 31_000;
  proc.emit("unhandledRejection", new Error("same"));
  await sleep(10);
  assert.equal(sent.length, 3);

  // uncaughtException: reported, then exit(1) after the delay even if the webhook fails
  proc.emit("uncaughtException", new Error("fatal"));
  assert.deepEqual(exits, []);
  await sleep(50);
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((l) => l.includes("Uncaught Exception: fatal")));

  const failing = new EventEmitter();
  const exits2: number[] = [];
  installProcessErrorHandlers({
    logger: { error: () => {} },
    webhook: { send: async () => Promise.reject(new Error("down")) },
    proc: failing,
    exit: (c) => void exits2.push(c),
    exitDelayMs: 10,
  });
  failing.emit("uncaughtException", null);
  await sleep(40);
  assert.deepEqual(exits2, [1]);

  console.log("processErrors tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
