import assert from "node:assert/strict";
import {
  COMMANDS_HASH_KEY,
  computeCommandsHash,
  registerCommandsIfChanged,
  stableStringify,
} from "./commandRegistry";

async function main() {
  const a = { name: "a", description: "x", options: [{ name: "o", type: 3 }] };
  const b = { name: "b", description: "y" };
  const h = computeCommandsHash([a, b]);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(computeCommandsHash([b, a]), h, "load order does not matter");
  assert.equal(
    computeCommandsHash([
      { options: [{ type: 3, name: "o" }], description: "x", name: "a" },
      { description: "y", name: "b", extra: undefined },
    ]),
    h,
    "key order and undefined keys do not matter",
  );
  assert.notEqual(computeCommandsHash([a, { ...b, description: "z" }]), h);
  assert.notEqual(
    computeCommandsHash([
      { ...a, options: [{ name: "p", type: 3 }, { name: "o", type: 3 }] },
      b,
    ]),
    computeCommandsHash([
      { ...a, options: [{ name: "o", type: 3 }, { name: "p", type: 3 }] },
      b,
    ]),
    "option order is significant",
  );
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');

  // registration: only when the hash differs; hash written only after a successful put
  const store = new Map<string, any>();
  const db = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: any) => void store.set(k, v),
  };
  let puts = 0;
  const base = { db, commandsJson: [a, b] };
  assert.equal(
    await registerCommandsIfChanged({ ...base, put: async () => void puts++ }),
    "registered",
  );
  assert.equal(puts, 1);
  assert.equal(store.get(COMMANDS_HASH_KEY), h);
  assert.equal(
    await registerCommandsIfChanged({ ...base, put: async () => void puts++ }),
    "unchanged",
  );
  assert.equal(puts, 1);
  assert.equal(
    await registerCommandsIfChanged({
      db,
      commandsJson: [a],
      put: async () => {
        throw new Error("429");
      },
    }),
    "failed",
  );
  assert.equal(store.get(COMMANDS_HASH_KEY), h, "failed put keeps the old hash so it retries");
  assert.equal(
    await registerCommandsIfChanged({ db, commandsJson: [a], put: async () => void puts++ }),
    "registered",
  );
  assert.equal(puts, 2);
  console.log("commandRegistry tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
