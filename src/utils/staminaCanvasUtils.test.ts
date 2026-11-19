import assert from "node:assert/strict";
import { loadImage } from "@napi-rs/canvas";
import { buildStaminaCard, STAMINA_CARD_WIDTH } from "./staminaCanvasUtils";
import { buildStaminaView } from "./staminaView";
import { createTranslator } from "./i18n";

async function main() {
  const now = Date.parse("2026-11-19T10:00:00Z");
  const sec = Math.floor(now / 1000);
  const detail: any = {
    base: { name: "Tester", roleId: "1", serverName: "Asia", level: 60 },
    dungeon: { curStamina: "100", maxStamina: "240", maxTs: String(sec + 7200) },
    dailyMission: { dailyActivation: 10, maxDailyActivation: 100 },
  };
  let previousHeight = 0;
  for (const lang of ["tw", "en"]) {
    const tr = createTranslator(lang);
    const full = await loadImage(await buildStaminaCard(buildStaminaView(detail, now), tr, now));
    assert.equal(full.width, STAMINA_CARD_WIDTH);
    // Fewer blocks give a shorter card (omitted, not zero-filled).
    const sparse = await loadImage(await buildStaminaCard(buildStaminaView({ ...detail, dailyMission: undefined }, now), tr, now));
    assert.ok(sparse.height < full.height);
    previousHeight = full.height;
  }
  assert.ok(previousHeight > 0);
  console.log("staminaCanvasUtils tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
