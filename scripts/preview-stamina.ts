// Run: node -r ts-node/register scripts/preview-stamina.ts
// Renders the /stamina card from fixtures into .tmp-layout/ (no network, no Discord).
import fs from "node:fs";
import path from "node:path";
import { buildStaminaView } from "../src/utils/staminaView";
import { buildStaminaCard } from "../src/utils/staminaCanvasUtils";
import { createTranslator } from "../src/utils/i18n";

async function main() {
  const out = path.resolve(__dirname, "../.tmp-layout");
  fs.mkdirSync(out, { recursive: true });
  const now = Date.parse("2026-11-19T10:00:00Z");
  const base = { name: "管理員 Perlica", roleId: "1234567890", serverName: "Asia", level: 60, saveTime: String(Math.floor(now / 1000) - 600) };
  const full = {
    base,
    dungeon: { curStamina: "132", maxStamina: "240", maxTs: String(Math.floor(now / 1000) + 6 * 3600 + 29 * 60) },
    dailyMission: { dailyActivation: 80, maxDailyActivation: 100 },
    weeklyMission: { score: 1450, total: 2000 },
    bpSystem: { curLevel: 23, maxLevel: 60 },
  };
  const cases: Array<[string, any, string]> = [
    ["preview-stamina.png", full, "tw"],
    ["preview-stamina-en.png", full, "en"],
    ["preview-stamina-full.png", { ...full, dungeon: { curStamina: "240", maxStamina: "240", maxTs: "0" }, dailyMission: { dailyActivation: 100, maxDailyActivation: 100 } }, "tw"],
    ["preview-stamina-partial.png", { base, dungeon: full.dungeon, bpSystem: full.bpSystem }, "tw"],
  ];
  for (const [file, detail, lang] of cases) {
    const png = await buildStaminaCard(buildStaminaView(detail, now), createTranslator(lang), now);
    fs.writeFileSync(path.join(out, file), png);
    console.log(path.join(out, file));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
