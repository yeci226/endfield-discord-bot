import assert from "node:assert/strict";
import { sumCategoryTotals } from "./summary";

const group = (nonFree: number, free: number, six: number, sixPulls: number, featured = 0, sixTotal = 0) => ({
  nonFreeTotal: nonFree,
  freeTotal: free,
  sixStarCount: six,
  sixStarPullCount: sixPulls,
  poolFeaturedSixMap: { p: featured },
  poolSixStarPullMap: { p: sixTotal },
});

const groupStats = {
  SpecialShared: group(200, 10, 4, 3, 2, 4),
  joint_1_0_1: group(120, 0, 2, 2, 0, 2),
  RerunShared: group(40, 0, 1, 1, 1, 1),
  Standard_c_standard_1: group(130, 0, 3, 3),
  Beginner: group(40, 0, 1, 1),
  w_pool: group(80, 0, 1, 1, 1, 1),
};
const pools = [
  { id: "c_special_1_0_1", type: "E_CharacterGachaPoolType_Special" },
  { id: "joint_1_0_1", type: "E_CharacterGachaPoolType_Joint" },
  { id: "c_standard_1", type: "E_CharacterGachaPoolType_Standard" },
];

function main() {
  // Joint-pool pulls belong to the limited-character category (the overview
  // lists those pools), so the limited totals must include them.
  const limited = sumCategoryTotals("limited_char", groupStats, pools);
  assert.equal(limited.nonFreeTotal, 200 + 120);
  assert.equal(limited.freeTotal, 10);
  assert.equal(limited.sixCount, 4 + 2);
  assert.equal(limited.sixPullCount, 3 + 2);
  // The win rate keeps its old basis: joint pools have no up/off-rate verdict.
  assert.equal(limited.featured, 2);
  assert.equal(limited.winRateTotal, 4);

  // A joint pool whose id does not start with "joint_" is found through its type.
  const odd = sumCategoryTotals(
    "limited_char",
    { SpecialShared: group(10, 0, 0, 0), odd_pool: group(5, 0, 0, 0) },
    [{ id: "odd_pool", type: "E_CharacterGachaPoolType_Joint" }],
  );
  assert.equal(odd.nonFreeTotal, 15);

  // Other categories are untouched.
  assert.equal(sumCategoryTotals("rerun_char", groupStats, pools).nonFreeTotal, 40);
  assert.equal(sumCategoryTotals("standard_char", groupStats, pools).nonFreeTotal, 130);
  assert.equal(sumCategoryTotals("beginner_char", groupStats, pools).nonFreeTotal, 40);
  assert.equal(
    sumCategoryTotals("weapon", { w_pool: groupStats.w_pool }, []).nonFreeTotal,
    80,
  );

  // No pools list (older callers): same result as before for limited.
  assert.equal(sumCategoryTotals("limited_char", groupStats, undefined).nonFreeTotal, 320);
}

main();
