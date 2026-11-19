import assert from "node:assert/strict";
import {
  isDeadInteractionError,
  planInteractionError,
  sendInteractionError,
} from "./shared";

async function main() {
  assert.equal(
    planInteractionError({ isAutocomplete: true, deferred: false, replied: false }),
    "respondEmpty",
  );
  assert.equal(
    planInteractionError({ isAutocomplete: false, deferred: false, replied: false }),
    "reply",
  );
  assert.equal(
    planInteractionError({ isAutocomplete: false, deferred: true, replied: false }),
    "followUp",
  );
  assert.equal(
    planInteractionError({ isAutocomplete: false, deferred: false, replied: true }),
    "followUp",
  );
  assert.equal(isDeadInteractionError({ code: 10062 }), true);
  assert.equal(isDeadInteractionError({ code: 40060 }), true);
  assert.equal(isDeadInteractionError({ code: 50013 }), false);
  assert.equal(isDeadInteractionError(null), false);

  const calls: string[] = [];
  const make = (extra: object) => ({
    isAutocomplete: () => false,
    reply: async (p: any) => void calls.push("reply:" + p.flags),
    followUp: async (p: any) => void calls.push("followUp:" + p.flags),
    respond: async (p: any) => void calls.push("respond:" + JSON.stringify(p)),
    ...extra,
  });
  assert.equal(await sendInteractionError(make({}), "x"), true);
  assert.equal(await sendInteractionError(make({ deferred: true }), "x"), true);
  assert.equal(
    await sendInteractionError(make({ isAutocomplete: () => true }), "x"),
    true,
  );
  assert.deepEqual(calls, ["reply:64", "followUp:64", "respond:[]"]);
  // an expired interaction makes the call throw: swallowed, reports false
  assert.equal(
    await sendInteractionError(
      make({ reply: async () => Promise.reject({ code: 10062 }) }),
      "x",
    ),
    false,
  );
  console.log("shared tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
