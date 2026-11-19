import assert from "node:assert/strict";
import {
  findPoolPage,
  pagePoolOptions,
  parsePoolPageValue,
  poolPageValue,
} from "./gachaPoolUtils";

const pools = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}` })); // p0 = newest
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);

/** options in the select = overview + items + paging options (max 25) */
function optionCount(r: ReturnType<typeof pagePoolOptions>) {
  return 1 + r.items.length + (r.hasOlder ? 1 : 0) + (r.hasNewer ? 1 : 0);
}

function main() {
  // 0 pools
  let r = pagePoolOptions(pools(0), 0);
  assert.deepEqual([r.items.length, r.page, r.totalPages, r.hasOlder, r.hasNewer], [0, 0, 1, false, false]);

  // 1 pool
  r = pagePoolOptions(pools(1), 0);
  assert.deepEqual(ids(r.items), ["p0"]);
  assert.equal(r.totalPages, 1);

  // 24 pools: everything fits beside the overview entry
  r = pagePoolOptions(pools(24), 0);
  assert.equal(r.items.length, 24);
  assert.equal(r.totalPages, 1);
  assert.equal(r.hasOlder, false);
  assert.equal(optionCount(r), 25);
  assert.equal(pagePoolOptions(pools(24), 5).page, 0, "page is clamped");

  // 25 pools: newest 23 + "older"; the 2 oldest on page 1 with "newer"
  r = pagePoolOptions(pools(25), 0);
  assert.equal(r.items.length, 23);
  assert.equal(ids(r.items)[0], "p0");
  assert.equal(r.hasOlder, true);
  assert.equal(r.hasNewer, false);
  assert.equal(r.totalPages, 2);
  assert.equal(optionCount(r), 25);
  r = pagePoolOptions(pools(25), 1);
  assert.deepEqual(ids(r.items), ["p23", "p24"]);
  assert.equal(r.hasNewer, true);
  assert.equal(r.hasOlder, false);

  // 60 pools: 23 + 22 + 15, and every pool is reachable exactly once
  const sixty = pools(60);
  const seen: string[] = [];
  const first = pagePoolOptions(sixty, 0);
  assert.equal(first.totalPages, 3);
  for (let p = 0; p < first.totalPages; p++) {
    const page = pagePoolOptions(sixty, p);
    assert.ok(optionCount(page) <= 25, `page ${p} fits a select`);
    assert.equal(page.hasNewer, p > 0);
    assert.equal(page.hasOlder, p < first.totalPages - 1);
    seen.push(...ids(page.items));
  }
  assert.deepEqual(seen, ids(sixty));
  assert.deepEqual(
    [0, 1, 2].map((p) => pagePoolOptions(sixty, p).items.length),
    [23, 22, 15],
  );
  assert.equal(pagePoolOptions(sixty, 99).page, 2);
  assert.equal(pagePoolOptions(sixty, -3).page, 0);

  // every size up to 200 is fully reachable and fits
  for (let n = 0; n <= 200; n++) {
    const list = pools(n);
    const total = pagePoolOptions(list, 0).totalPages;
    const all: string[] = [];
    for (let p = 0; p < total; p++) {
      const page = pagePoolOptions(list, p);
      assert.ok(optionCount(page) <= 25, `n=${n} page ${p}`);
      all.push(...ids(page.items));
    }
    assert.deepEqual(all, ids(list), `n=${n}`);
  }

  // finding the page of a selected pool
  assert.equal(findPoolPage(sixty, "p0"), 0);
  assert.equal(findPoolPage(sixty, "p22"), 0);
  assert.equal(findPoolPage(sixty, "p23"), 1);
  assert.equal(findPoolPage(sixty, "p44"), 1);
  assert.equal(findPoolPage(sixty, "p45"), 2);
  assert.equal(findPoolPage(sixty, "p59"), 2);
  assert.equal(findPoolPage(sixty, "nope"), 0);

  // paging option values
  assert.equal(poolPageValue(2), "__pp:2");
  assert.equal(parsePoolPageValue("__pp:2"), 2);
  assert.equal(parsePoolPageValue("__pp:"), null);
  assert.equal(parsePoolPageValue("__pp:x"), null);
  assert.equal(parsePoolPageValue("all"), null);
  assert.equal(parsePoolPageValue("c_special_1_0_1"), null);
  assert.equal(parsePoolPageValue(undefined), null);

  console.log("gacha pool select paging tests passed");
}

main();
