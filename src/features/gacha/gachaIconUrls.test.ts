import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import {
  GACHA_ICON_URLS_KEY,
  extractPoolIconUrls,
  iconIdFromPic,
  newIconUrls,
  rememberIconUrls,
  sanitizeStoredIconUrls,
} from "./gachaIconUrls";
import {
  getGachaIconUrlCandidates,
  refreshStoredIconUrls,
  resetStoredIconUrls,
  STORED_ICON_URLS_TTL_MS,
} from "./iconLoader";

const HY = "https://bbs.hycdn.cn/image/common/2026/icon_chr_0099_newguy.png";
const SK = "https://web-static.skport.com/endfield/wpn_sword_0099_x.png";

async function testExtraction() {
  assert.equal(iconIdFromPic("character", HY), "chr_0099_newguy");
  assert.equal(iconIdFromPic("weapon", SK), "wpn_sword_0099");
  assert.equal(iconIdFromPic("character", "https://bbs.hycdn.cn/a/b/6979ace2deae.png"), null);
  assert.equal(iconIdFromPic("weapon", undefined), null);

  const found = extractPoolIconUrls(
    [
      {
        chars: [
          { pic: HY },
          { pic: "https://evil.example.com/icon_chr_0001_bad.png" }, // host not allowed
          { pic: "http://bbs.hycdn.cn/icon_chr_0002_http.png" }, // not https
          { pic: "https://bbs.hycdn.cn/hash-only.png" }, // no id in the name
          { pic: "https://endfieldtools.dev/x/icon_chr_0003_mirror.png" }, // renderer extra host
          {},
        ],
      },
      {},
    ],
    [{ weapons: [{ pic: SK }, { pic: "https://10.0.0.1/wpn_sword_0001.png" }] }],
  );
  assert.deepEqual(found, {
    chr_0099_newguy: HY,
    chr_0003_mirror: "https://endfieldtools.dev/x/icon_chr_0003_mirror.png",
    wpn_sword_0099: SK,
  });
  assert.deepEqual(extractPoolIconUrls(undefined, undefined), {});
  assert.deepEqual(newIconUrls({ a: "1" }, { a: "2", b: "3" }), { b: "3" });
}

async function testRemember() {
  const db = new CustomDatabase(":memory:");
  let updates = 0;
  const counting = {
    get: (k: string) => db.get(k),
    update: ((k: string, fn: any) => (updates++, db.update(k, fn))) as any,
  };
  assert.equal(await rememberIconUrls(counting, {}), 0);
  assert.equal(updates, 0, "nothing found: no write");
  assert.equal(await rememberIconUrls(counting, { chr_0099_newguy: HY }), 1);
  assert.equal(updates, 1);
  assert.deepEqual(await db.get(GACHA_ICON_URLS_KEY), { chr_0099_newguy: HY });
  // same ids again, even with a rotated URL: no write
  assert.equal(
    await rememberIconUrls(counting, { chr_0099_newguy: HY + "?v=2" }),
    0,
  );
  assert.equal(updates, 1, "no new ids: no write");
  // a gain merges, keeping the old entries
  assert.equal(await rememberIconUrls(counting, { chr_0099_newguy: HY, wpn_sword_0099: SK }), 1);
  assert.equal(updates, 2);
  assert.deepEqual(await db.get(GACHA_ICON_URLS_KEY), {
    chr_0099_newguy: HY,
    wpn_sword_0099: SK,
  });
  db.close();
}

async function testIconLoaderFallback() {
  // last fallback, after the hardcoded table and the mirrors
  const stored = { chr_0099_newguy: HY, chr_0034_typhoea: "https://bbs.hycdn.cn/icon_chr_0034_typhoea.png" };
  const known = getGachaIconUrlCandidates(true, "chr_0034_typhoea", stored);
  assert.equal(known.length, 4);
  assert.equal(known[known.length - 1], stored.chr_0034_typhoea);
  assert.deepEqual(getGachaIconUrlCandidates(true, "chr_0099_newguy", stored), [
    "https://endfieldtools.dev/assets/images/endfield/charicon/icon_chr_0099_newguy.png",
    "https://endfield.ooo.run/ake/operators/icon_chr_0099_newguy.webp",
    HY,
  ]);
  assert.deepEqual(getGachaIconUrlCandidates(false, "wpn_sword_0099", { wpn_sword_0099: SK }), [SK]);
  assert.deepEqual(getGachaIconUrlCandidates(false, "icon_wpn_sword_0099", { wpn_sword_0099: SK }), [SK]);
  // without a stored map the lists are exactly what they were
  assert.deepEqual(getGachaIconUrlCandidates(false, "wpn_lance_9999"), []);
  assert.equal(getGachaIconUrlCandidates(true, "chr_9999_unknown").length, 2);

  // the row is sanitized on the way in, and read at most once per minute
  assert.deepEqual(
    sanitizeStoredIconUrls({
      chr_ok: HY,
      chr_bad_host: "https://evil.example.com/x.png",
      "not an id": HY,
      wpn_x_1: 42,
    }),
    { chr_ok: HY },
  );
  resetStoredIconUrls();
  let reads = 0;
  const db = {
    get: async () => (reads++, { chr_0099_newguy: HY, chr_evil: "https://evil.example.com/x.png" } as any),
  };
  const t0 = 1_800_000_000_000;
  await refreshStoredIconUrls(db, t0);
  await refreshStoredIconUrls(db, t0 + 1000);
  await refreshStoredIconUrls(db, t0 + STORED_ICON_URLS_TTL_MS - 1);
  assert.equal(reads, 1, "one read per minute, not per icon");
  await refreshStoredIconUrls(db, t0 + STORED_ICON_URLS_TTL_MS + 1);
  assert.equal(reads, 2);
  // a failing read keeps the map usable
  const failing = {
    get: async () => {
      throw new Error("db down");
    },
  };
  await refreshStoredIconUrls(failing as any, t0 + 10 * STORED_ICON_URLS_TTL_MS);
  resetStoredIconUrls();
}

async function main() {
  await testExtraction();
  await testRemember();
  await testIconLoaderFallback();
  console.log("gacha icon url tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
