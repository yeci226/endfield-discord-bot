import assert from "node:assert/strict";
import axios from "axios";
import { CustomDatabase } from "./Database";
import {
  fetchAndMergeGachaLog,
  GachaLogData,
  GachaRecord,
  getGachaStats,
  updateLeaderboard,
} from "./gachaLogUtils";

async function main() {
  const db = new CustomDatabase(":memory:");
  const originalGet = axios.get;
  const records: GachaRecord[] = [];
  const add = (poolId: string, fields: Partial<GachaRecord> = {}) => {
    records.push({
      seqId: String(records.length + 1),
      gachaTs: String(1700000000000 + records.length),
      poolId,
      poolName: poolId,
      poolType: "E_CharacterGachaPoolType_Special",
      isFree: false,
      rarity: 4,
      charId: "chr_test",
      kind: "draw",
      ...fields,
    });
  };
  const gift = (poolId: string) =>
    add(poolId, {
      kind: "gift_intel_book",
      nameText: "Headhunting Dossier",
      charId: undefined,
      rarity: undefined,
    });

  try {
    // The previous pool leaves 16 pity. Its dossier must not add a 17th pull.
    for (let i = 1; i <= 70; i++) {
      add("previous", { rarity: i === 54 ? 6 : 4, kind: undefined });
    }
    gift("previous");
    for (let i = 0; i < 10; i++) add("current", { isFree: true, rarity: 6 });
    for (let i = 1; i <= 60; i++) {
      add("current", { rarity: i === 46 ? 6 : 4 });
    }
    gift("current");
    const data: GachaLogData = {
      characterList: [...records].reverse(),
      weaponList: [],
      info: { uid: "test", lang: "en-us", export_timestamp: 0 },
    };
    for (const pool of ["previous", "current", "weapon"]) {
      await db.set(`GACHA_POOL_METADATA_${pool}`, { data: {} });
    }
    // All checks are offline; unexpected metadata/API requests fail the test.
    axios.get = (async () => {
      throw new Error("Unexpected network request");
    }) as typeof axios.get;

    const before = JSON.stringify(data);
    const stats = await getGachaStats(db, data);
    const summary = stats.char.summary.SpecialShared;
    assert.equal(summary.total, 140);
    assert.equal(summary.nonFreeTotal, 130);
    assert.equal(summary.freeTotal, 10);
    assert.equal(summary.currentPity, 14);
    assert.equal(summary.sixStarCount, 12);
    assert.equal(summary.sixStarPullCount, 2);
    const current = stats.char.pools.find((pool) => pool.id === "current")!;
    assert.equal(current.total, 60);
    assert.equal(current.freeCount, 10);
    const latestSix = stats.char.history.find(
      (record) =>
        record.poolId === "current" && record.rarity === 6 && !record.isFree,
    );
    assert.equal(latestSix.pitySixCount, 62);
    assert.equal(latestSix.poolTotalCount, 46);
    assert.equal(
      JSON.stringify(data),
      before,
      "raw history must remain intact",
    );

    await db.set("GACHA_LOG_test", data);
    await updateLeaderboard(db, "test", data);
    const entry = (await db.get("GACHA_LEADERBOARD_ENTRIES")).test;
    assert.equal(entry.total, 140);
    assert.equal(entry.stats.TOTAL.total, 130);
    assert.equal(entry.stats.SpecialShared.total, 130);
    assert.equal(entry.stats.current.total, 60);
    assert.equal(entry.stats.previous.total, 70);

    // Explicit non-draw events are not pulls, even if they carry item metadata.
    const weaponStats = await getGachaStats(db, {
      ...data,
      characterList: [],
      weaponList: [
        {
          ...records[0],
          poolId: "weapon",
          poolType: "WeaponPool",
          kind: "gift_item",
          rarity: 6,
        },
        {
          ...records[0],
          poolId: "weapon",
          poolType: "WeaponPool",
          kind: "draw",
          weaponId: "wpn_test",
        },
        {
          ...records[0],
          poolId: "weapon",
          poolType: "WeaponPool",
          kind: undefined,
          weaponId: "wpn_test",
          isFree: true,
        },
      ],
    });
    assert.equal(weaponStats.weapon.total, 2);
    assert.equal(weaponStats.weapon.nonFreeTotal, 1);
    assert.equal(weaponStats.weapon.freeTotal, 1);
    assert.equal(weaponStats.weapon.WeaponShared.sixStarCount, 0);

    // A page containing only a gift must still advance the API cursor. Reimport
    // keeps raw events for cursor/gap tracking, but reports/counts only real pulls.
    await db.set("GACHA_LOG_test", data);
    const cursors: unknown[] = [];
    axios.get = (async (url: string, config: any) => {
      if (url.endsWith("/api/record/weapon/pool"))
        return { data: { code: 0, data: [] } };
      assert.ok(url.endsWith("/api/record/char"));
      if (config.params.pool_type !== "E_CharacterGachaPoolType_Special") {
        return { data: { code: 0, data: { list: [], hasMore: false } } };
      }
      cursors.push(config.params.seq_id);
      return {
        data: {
          code: 0,
          data: {
            list: config.params.seq_id
              ? data.characterList.slice(1)
              : data.characterList.slice(0, 1),
            hasMore: !config.params.seq_id,
          },
        },
      };
    }) as typeof axios.get;
    const result = await fetchAndMergeGachaLog(
      db,
      "https://example.invalid/page?token=test&server_id=2",
      undefined,
      "test",
    );
    assert.deepEqual(cursors, [undefined, data.characterList[0].seqId]);
    assert.equal(result.totalChar, 140);
    assert.equal(result.totalWeapon, 0);
    assert.equal(result.hasDataGap, false);
    assert.equal(result.data.characterList.length, 142);
    assert.equal(
      (await getGachaStats(db, result.data)).char.summary.SpecialShared
        .currentPity,
      14,
    );
    await db.delete("GACHA_LOG_test");
    await updateLeaderboard(db, "test", result.data);
    assert.equal(
      (await db.get("GACHA_LEADERBOARD_ENTRIES")).test,
      undefined,
      "An in-flight leaderboard refresh must not restore a deleted account",
    );
    console.log(
      "Gacha non-draw event and deleted leaderboard regression tests passed",
    );
  } finally {
    axios.get = originalGet;
    (db as any).db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
