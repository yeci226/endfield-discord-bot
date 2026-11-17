import assert from "node:assert/strict";
import { getWinRateCounts } from "./gachaCanvasUtils";

function main() {
  // Mirrors the reported card: 7 paid 6★ + 4 free (expedited) 6★, 9 of them featured.
  // Old overview code divided 9 featured (incl. free) by 7 paid 6★ => 128%/112.5%.
  const summary = {
    sixStarPullCount: 7, // non-free only
    poolSixStarPullMap: { poolA: 2, poolB: 6, poolC: 3 }, // all 6★ incl. free
    poolFeaturedSixMap: { poolA: 1, poolB: 5, poolC: 3 },
  };
  const { featured, total } = getWinRateCounts(summary);
  assert.equal(featured, 9);
  assert.equal(total, 11);
  assert.ok(featured <= total, "featured 6★ must never exceed total 6★");

  assert.deepEqual(getWinRateCounts({}), { featured: 0, total: 0 });
}

main();
