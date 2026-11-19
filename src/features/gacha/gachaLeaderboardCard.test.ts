import assert from "node:assert/strict";
import { drawGachaLeaderboard } from "../../utils/gachaLeaderboardCanvasUtils";
import { buildLeaderboardView, sixStarRate } from "./gachaLeaderboard";
import { GachaLeaderboardEntry } from "./gachaTypes";
import { createTranslator } from "../../utils/i18n";

// No avatarUrl: nothing is fetched. (The random fallback avatar is the only
// nondeterminism, so this test compares sizes and call equivalence, not pixels.)
function entry(i: number): GachaLeaderboardEntry {
  const total = 150 + i * 13;
  const six = 2 + (i % 5);
  return {
    uid: `EF_${5000 + i}`,
    nickname: `P${i}`,
    displayName: `D${i}`,
    lastUpdate: 0,
    total,
    nonFreeTotal: total,
    freeTotal: 0,
    guilds: i % 2 ? ["g"] : [],
    stats: {
      TOTAL: {
        total,
        sixStarCount: six,
        fiveStarCount: 5,
        probability: sixStarRate(six, total),
      },
    },
  };
}

async function main() {
  const entries = Array.from({ length: 23 }, (_, i) => entry(i));
  const tr = createTranslator("tw");
  const mine = [entries[22].uid];

  // The old six-argument call still works and renders page 1 of the global board.
  const legacy = await drawGachaLeaderboard(entries, mine, "TOTAL", "pulls", tr, {});
  assert.ok(legacy.length > 1000);

  // Passing a precomputed view or the raw options gives a picture of the same size.
  const view = buildLeaderboardView(entries, { poolId: "TOTAL", sortType: "pulls", page: 1, myUids: mine });
  const viaView = await drawGachaLeaderboard(entries, mine, "TOTAL", "pulls", tr, {}, { view });
  const viaPage = await drawGachaLeaderboard(entries, mine, "TOTAL", "pulls", tr, {}, { page: 1 });
  assert.ok(viaView.length > 1000 && viaPage.length > 1000);

  // Every translation key the board uses exists in both languages.
  for (const lang of ["tw", "en"]) {
    const t = createTranslator(lang);
    for (const key of [
      "gacha_log_leaderboard_scope_global",
      "gacha_log_leaderboard_scope_guild",
      "gacha_log_leaderboard_scope_placeholder",
      "gacha_log_leaderboard_scope_empty",
      "gacha_log_leaderboard_page",
      "gacha_log_leaderboard_my_rank",
      "gacha_log_leaderboard_no_rank",
      "gacha_log_leaderboard_luck_min",
      "gacha_log_leaderboard_close",
    ]) {
      assert.notEqual(t(key), key, `${lang} is missing ${key}`);
    }
    assert.match(t("gacha_log_leaderboard_page", { page: 2, pages: 5 }), /2.*5/);
    assert.match(t("gacha_log_leaderboard_luck_min", { min: 100, count: 7 }), /100.*7/);
  }
  console.log("Gacha leaderboard card tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
