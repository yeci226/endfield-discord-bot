import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { buildSimResultContent } from "./simulate";

const tr = (key: string, opts?: any) =>
  key === "gacha_sim_result_content"
    ? opts.poolName + "|" + opts.note
    : `${key}${opts ? JSON.stringify(opts) : ""}`;

function main() {
  const cfg = { poolName: "P", sixStarUp: { id: "x" }, isSpecial: true };
  const state = {
    sixStarPity: 10,
    fiveStarPity: 3,
    isGuaranteed: true,
    pullsWithoutCurrentUp: 50,
  };
  const text = buildSimResultContent(tr, cfg, state);
  assert.ok(text.includes("gacha_sim_note_summary"));
  assert.ok(text.includes('"sixRemaining":70'));
  assert.ok(text.includes('"fiveRemaining":7'));
  assert.ok(text.includes('"remaining":70'));
  assert.ok(text.includes("gacha_sim_next_six_rate_up"));

  // same state, same text
  assert.equal(buildSimResultContent(tr, cfg, { ...state }), text);

  // last pull before the current-UP guarantee
  assert.ok(
    buildSimResultContent(tr, cfg, { ...state, pullsWithoutCurrentUp: 119 }).includes(
      "gacha_sim_current_up_guarantee_next",
    ),
  );
  // no UP banner / not guaranteed: no extra lines
  const plain = buildSimResultContent(
    tr,
    { poolName: "P", isSpecial: false },
    { ...state, isGuaranteed: false },
  );
  assert.ok(!plain.includes("guarantee") && !plain.includes("next_six"));

  // the slash reply and the button reply share this one function
  const src = fs.readFileSync(path.join(__dirname, "simulate.ts"), "utf8");
  assert.equal(src.split("buildSimResultContent(tr,").length - 1, 2);
  assert.ok(!src.includes("gacha_sim_next_six_limited"));
}

main();
