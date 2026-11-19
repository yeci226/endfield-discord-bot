import assert from "node:assert/strict";
import {
  buildGachaCardKey,
  canonicalStringify,
  CARD_CACHE_MAX_BYTES,
  CARD_CACHE_MAX_ENTRIES,
  getOrRenderCard,
  renderedCardCache,
} from "./cardCache";

const baseInput = () => ({
  data: {
    info: { uid: "EF_1", nickname: "A", lang: "zh-tw", export_timestamp: 5 },
  },
  stats: { char: { total: 3, history: [{ name: "x", rarity: 6 }] } },
  type: "limited_char",
  selectedPoolId: undefined as string | undefined,
  page: 0,
  lang: "tw",
});

async function main() {
  // canonical form ignores key order and undefined
  assert.equal(
    canonicalStringify({ b: 1, a: { d: [1, undefined], c: undefined } }),
    canonicalStringify({ a: { c: undefined, d: [1, undefined] }, b: 1 }),
  );
  assert.notEqual(canonicalStringify({ a: 1 }), canonicalStringify({ a: "1" }));

  // identical inputs -> same key; every pixel-relevant field changes it
  const k0 = buildGachaCardKey(baseInput());
  assert.equal(buildGachaCardKey(baseInput()), k0);
  const variants: Array<(i: any) => void> = [
    (i) => (i.data.info.uid = "EF_2"),
    (i) => (i.data.info.nickname = "B"),
    (i) => (i.stats.char.total = 4),
    (i) => (i.stats.char.history[0].rarity = 5),
    (i) => (i.type = "weapon"),
    (i) => (i.selectedPoolId = "p1"),
    (i) => (i.page = 1),
    (i) => (i.lang = "en"),
  ];
  const keys = new Set([k0]);
  for (const mutate of variants) {
    const i = baseInput();
    mutate(i);
    keys.add(buildGachaCardKey(i));
  }
  assert.equal(keys.size, variants.length + 1);

  // two users with identical stats but different UIDs never share a card
  const userA = baseInput();
  const userB = baseInput();
  userB.data.info.uid = "EF_OTHER";
  assert.notEqual(buildGachaCardKey(userA), buildGachaCardKey(userB));

  // clock minute only matters when the log has no export timestamp
  const noTs = baseInput();
  delete (noTs.data.info as any).export_timestamp;
  assert.equal(
    buildGachaCardKey({ ...noTs, now: 60_000 * 10 }),
    buildGachaCardKey({ ...noTs, now: 60_000 * 10 + 59_000 }),
  );
  assert.notEqual(
    buildGachaCardKey({ ...noTs, now: 60_000 * 10 }),
    buildGachaCardKey({ ...noTs, now: 60_000 * 11 }),
  );
  assert.equal(
    buildGachaCardKey({ ...baseInput(), now: 1 }),
    buildGachaCardKey({ ...baseInput(), now: 10 ** 12 }),
  );

  // hit returns the stored buffer without rendering; miss renders once
  renderedCardCache.clear();
  let renders = 0;
  const render = async () => {
    renders++;
    return Buffer.from("card-" + renders);
  };
  const a = await getOrRenderCard("k1", render);
  const b = await getOrRenderCard("k1", render);
  assert.equal(renders, 1);
  assert.equal(a, b); // same object
  const c = await getOrRenderCard("k2", render);
  assert.equal(renders, 2);
  assert.notEqual(c, a);

  // concurrent identical requests share one render
  renderedCardCache.clear();
  renders = 0;
  const [p, q] = await Promise.all([
    getOrRenderCard("k3", render),
    getOrRenderCard("k3", render),
  ]);
  assert.equal(renders, 1);
  assert.equal(p, q);

  // empty buffers are never cached
  renderedCardCache.clear();
  let emptyCalls = 0;
  const renderEmpty = async () => {
    emptyCalls++;
    return Buffer.alloc(0);
  };
  await getOrRenderCard("e", renderEmpty);
  await getOrRenderCard("e", renderEmpty);
  assert.equal(emptyCalls, 2);

  // bypass renders every time
  renderedCardCache.clear();
  renderedCardCache.enabled = false;
  renders = 0;
  await getOrRenderCard("k4", render);
  await getOrRenderCard("k4", render);
  assert.equal(renders, 2);
  renderedCardCache.enabled = true;

  // caps: entries and bytes
  renderedCardCache.clear();
  for (let i = 0; i < CARD_CACHE_MAX_ENTRIES + 50; i++) {
    renderedCardCache.set("n" + i, Buffer.alloc(10));
  }
  assert.equal(renderedCardCache.size, CARD_CACHE_MAX_ENTRIES);
  assert.equal(renderedCardCache.get("n0"), undefined);
  renderedCardCache.clear();
  const chunk = 8 * 1024 * 1024;
  for (let i = 0; i < 20; i++) {
    renderedCardCache.set("b" + i, Buffer.alloc(chunk));
  }
  assert.ok(renderedCardCache.bytes <= CARD_CACHE_MAX_BYTES);
  assert.equal(renderedCardCache.size, CARD_CACHE_MAX_BYTES / chunk);
  renderedCardCache.clear();
}

main();
