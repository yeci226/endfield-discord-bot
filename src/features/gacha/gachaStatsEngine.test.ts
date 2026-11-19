import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import { getWinRateCounts } from "../../utils/gachaCanvasUtils";
import {
  classifyFeaturedSixStar,
  ENGINE_VERSION,
  FeaturedStatus,
  getGachaStats,
  isLimitedRateUpPool,
} from "./gachaStatsEngine";
import { GachaLogData, GachaRecord } from "./gachaTypes";

const STANDARD = new Set([
  "chr_0009_azrila",
  "chr_0015_lifeng",
  "chr_0025_ardelia",
]);

const rec = (over: Partial<GachaRecord>): GachaRecord => ({
  seqId: "1",
  rarity: 6,
  gachaTs: "1760000000000",
  poolId: "c_special_x",
  poolName: "特選尋訪「測試」",
  poolType: "E_CharacterGachaPoolType_Special",
  isFree: false,
  ...over,
});

const META_WITH_ALL = {
  up6_name: "Laevatain",
  up6_item_name: "Laevatain",
  all: [
    { id: "chr_0016_laevat", name: "Laevatain", rarity: 6 },
    { id: "chr_0009_azrila", name: "Azrila", rarity: 6 },
  ],
};

async function main() {
  assert.ok(ENGINE_VERSION >= 2, "the featured rule change bumped the engine version");

  // --- classification table -----------------------------------------------------
  const table: Array<{
    why: string;
    record: GachaRecord;
    name?: string;
    meta: any;
    expect: FeaturedStatus;
  }> = [
    {
      why: "metadata up6 id matches",
      record: rec({ charId: "chr_0016_laevat", charName: "Laevatain" }),
      name: "Laevatain",
      meta: META_WITH_ALL,
      expect: "featured",
    },
    {
      why: "metadata knows the up6 and this is another 6-star",
      record: rec({ charId: "chr_0009_azrila", charName: "Azrila" }),
      name: "Azrila",
      meta: META_WITH_ALL,
      expect: "offRate",
    },
    {
      why: "a NEW permanent character missing from every list, but metadata names the up6",
      record: rec({ charId: "chr_0099_newperm", charName: "Newperm" }),
      name: "Newperm",
      meta: META_WITH_ALL,
      expect: "offRate",
    },
    {
      why: "metadata without the item list: up6 name equals",
      record: rec({ charId: "chr_0016_laevat", charName: "Laevatain" }),
      name: "Laevatain",
      meta: { up6_name: "Laevatain" },
      expect: "featured",
    },
    {
      why: "metadata without the item list: up6 name differs",
      record: rec({ charId: "chr_0099_newperm", charName: "Newperm" }),
      name: "Newperm",
      meta: { up6_item_name: "Laevatain" },
      expect: "offRate",
    },
    {
      why: "no metadata: the item's name is in the pool title",
      record: rec({
        charId: "chr_0016_laevat",
        charName: "Laevatain",
        poolName: "特選尋訪「Laevatain」",
      }),
      name: "Laevatain",
      meta: null,
      expect: "featured",
    },
    {
      why: "no metadata, standard list member",
      record: rec({ charId: "chr_0009_azrila", charName: "Azrila" }),
      name: "Azrila",
      meta: null,
      expect: "offRate",
    },
    {
      why: "no metadata, icon_ prefix on the id still hits the standard list",
      record: rec({ charId: "icon_chr_0009_azrila", charName: "Azrila" }),
      name: "Azrila",
      meta: {},
      expect: "offRate",
    },
    {
      why: "no metadata, NEW permanent character absent from the hardcoded list => unknown, not featured",
      record: rec({ charId: "chr_0099_newperm", charName: "Newperm" }),
      name: "Newperm",
      meta: null,
      expect: "unknown",
    },
    {
      why: "no metadata and no name at all: an empty name must not match every pool title",
      record: rec({ charId: "chr_0099_newperm" }),
      name: undefined,
      meta: null,
      expect: "unknown",
    },
    {
      why: "weapon: metadata up6 id",
      record: rec({
        charId: undefined,
        weaponId: "wpn_sword_0005",
        weaponName: "Sword Six A",
        poolType: "WeaponPool",
      }),
      name: "Sword Six A",
      meta: {
        up6_name: "Sword Six A",
        all: [{ id: "wpn_sword_0005", name: "Sword Six A", rarity: 6 }],
      },
      expect: "featured",
    },
  ];
  for (const row of table) {
    assert.equal(
      classifyFeaturedSixStar(row.record, row.name, row.meta, STANDARD),
      row.expect,
      row.why,
    );
  }

  assert.equal(isLimitedRateUpPool({ poolType: "E_CharacterGachaPoolType_Special" }), true);
  assert.equal(isLimitedRateUpPool({ poolType: "Rerun" }), true);
  assert.equal(isLimitedRateUpPool({ poolType: "WeaponPool" }), true);
  assert.equal(isLimitedRateUpPool({ poolName: "特選尋訪" }), true);
  assert.equal(isLimitedRateUpPool({ poolType: "E_CharacterGachaPoolType_Standard" }), false);

  // --- end to end: unknown is in neither side of the win rate ------------------------
  const db = new CustomDatabase(":memory:");
  await db.set("GACHA_POOL_METADATA_c_special_known", {
    data: META_WITH_ALL,
    lastFetch: 0,
  });
  // c_special_unknown has no stored metadata and the fake fetch must not be reached:
  await db.set("GACHA_POOL_METADATA_c_special_unknown", {
    data: { all: [] },
    lastFetch: 0,
  });
  const log: GachaLogData = {
    characterList: [
      // newest first
      rec({ seqId: "5", poolId: "c_special_unknown", charId: "chr_0099_newperm", charName: "Newperm" }),
      rec({ seqId: "4", poolId: "c_special_known", charId: "chr_0009_azrila", charName: "Azrila" }),
      rec({ seqId: "3", poolId: "c_special_known", charId: "chr_0016_laevat", charName: "Laevatain" }),
      rec({ seqId: "2", poolId: "c_special_known", rarity: 4, charId: "chr_x", charName: "X" }),
      rec({ seqId: "1", poolId: "c_special_known", charId: "chr_0016_laevat", charName: "Laevatain", poolName: "特選尋訪「已知」" }),
    ],
    weaponList: [],
    info: { uid: "EF_1", lang: "zh-tw", serverId: "2", export_timestamp: 1 },
  };
  const stats: any = await getGachaStats(db, log);
  assert.equal(stats.char.unknownFeaturedCount, 1);
  assert.equal(stats.weapon.unknownFeaturedCount, 0);
  const unknownPool = stats.char.pools.find((p: any) => p.id === "c_special_unknown");
  assert.equal(unknownPool.unknownFeaturedCount, 1);
  assert.equal(unknownPool.sixStarPullCount, 0, "unknown 6* is not in the denominator");
  assert.equal(unknownPool.featuredSixCount, 0);
  const knownPool = stats.char.pools.find((p: any) => p.id === "c_special_known");
  assert.equal(knownPool.sixStarPullCount, 3);
  assert.equal(knownPool.featuredSixCount, 2);
  assert.deepEqual(getWinRateCounts(stats.char.summary.SpecialShared), {
    featured: 2,
    total: 3,
  });
  const item = stats.char.history.find((h: any) => h.seqId === "5");
  assert.equal(item.isFeatured, false);
  assert.equal(item.isOffRate, false);
  assert.equal(item.isUnknownFeatured, true);
  assert.equal(
    stats.char.history.find((h: any) => h.seqId === "3").isUnknownFeatured,
    undefined,
  );

  // The stats must survive the cache's JSON round trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats);

  console.log("gacha stats engine tests passed");
}

void main();
