import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import {
  getEmbeddedInvokerId,
  handleGachaButton,
  handleGachaSelectMenu,
} from "./components";
import { leaderboardCustomIdFor } from "./leaderboard";
import { parseLeaderboardCustomId } from "../../../utils/gachaLogUtils";

const lbModule = require("./leaderboard");
const originalHandler = lbModule.handleGachaLeaderboardComponent;

const OWNER = "111111111111111111";
const OTHER = "222222222222222222";
const ACTIONS = [
  "lb_type",
  "lb_pool",
  "lb_subpool",
  "lb_sort",
  "lb_scope",
  "lb_page",
  "lb_me",
  "lb_close",
];
const state = { poolId: "TOTAL", sortType: "luck", scope: "global", page: 2 } as const;

function fake(customId: string, userId: string, withMetadata = true) {
  const calls: string[] = [];
  const interaction: any = {
    user: { id: userId },
    customId,
    values: ["x"],
    message: {
      flags: { has: (f: any) => f === MessageFlags.Ephemeral && false },
      ...(withMetadata ? { interactionMetadata: { user: { id: OWNER } } } : {}),
    },
    reply: async () => {
      calls.push("reply");
    },
    deferUpdate: async () => {
      calls.push("deferUpdate");
    },
  };
  const ctx: any = { tr: (k: string) => k, db: {}, interaction };
  return { ctx, interaction, calls };
}

async function main() {
  let handlerCalls = 0;
  lbModule.handleGachaLeaderboardComponent = async () => {
    handlerCalls++;
    return true;
  };
  try {
    for (const action of ACTIONS) {
      const id = leaderboardCustomIdFor(OWNER, action as any, state as any);
      const isButton = ["lb_page", "lb_me", "lb_close"].includes(action);
      const run = (f: any) =>
        isButton ? handleGachaButton(f.ctx, f.interaction) : handleGachaSelectMenu(f.ctx, f.interaction);

      handlerCalls = 0;
      await run(fake(id, OWNER));
      assert.equal(handlerCalls, 1, `${action}: invoker reaches the handler`);

      handlerCalls = 0;
      const bystander = fake(id, OTHER);
      await run(bystander);
      assert.equal(handlerCalls, 0, `${action}: bystander never reaches the handler`);
      assert.deepEqual(bystander.calls, ["reply"], `${action}: one ephemeral notice`);

      // the embedded id alone refuses a bystander even where Discord has no record
      handlerCalls = 0;
      const noRecord = fake(id, OTHER, false);
      await run(noRecord);
      assert.equal(handlerCalls, 0, `${action}: embedded id refuses without metadata`);
    }

    // ids posted before the invoker was embedded still work for their invoker only
    for (const old of [
      "gacha:lb_pool:all:pulls",
      "gacha:lb_sort:TOTAL:luck:guild:3",
    ]) {
      assert.equal(getEmbeddedInvokerId(old.split(":")), null, old);
      assert.ok(parseLeaderboardCustomId(old), old);
      handlerCalls = 0;
      const o = fake(old, OWNER);
      await handleGachaSelectMenu(o.ctx, o.interaction);
      assert.equal(handlerCalls, 1, `${old}: old id works for its invoker`);
      handlerCalls = 0;
      const b = fake(old, OTHER);
      await handleGachaSelectMenu(b.ctx, b.interaction);
      assert.equal(handlerCalls, 0, `${old}: old id refuses a bystander`);
    }

    // round trip
    const id = leaderboardCustomIdFor(OWNER, "lb_page", state as any);
    assert.equal(getEmbeddedInvokerId(id.split(":")), OWNER);
    assert.deepEqual(parseLeaderboardCustomId(id), { action: "lb_page", ...state });
  } finally {
    lbModule.handleGachaLeaderboardComponent = originalHandler;
  }
  console.log("leaderboardComponents ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
