import assert from "node:assert/strict";
import axios from "axios";
import { CustomDatabase } from "./Database";
import {
  fetchAndMergeGachaLog,
  GachaRecord,
  getGachaStats,
} from "./gachaLogUtils";

async function main() {
  const db = new CustomDatabase(":memory:");
  const originalGet = axios.get;
  const rerunType = "E_CharacterGachaPoolType_Rerun";
  const specialType = "E_CharacterGachaPoolType_Special";
  const records: GachaRecord[] = [];
  const add = (
    poolId: string,
    poolType: string,
    fields: Partial<GachaRecord> = {},
  ) =>
    records.push({
      seqId: String(records.length + 1),
      gachaTs: String(1700000000000 + records.length),
      poolId,
      poolType,
      poolName: poolId,
      rarity: 4,
      isFree: false,
      kind: "draw",
      charId: "chr_four",
      ...fields,
    });
  try {
    // The reporting user's 40 records consist of 30 paid + 10 expedited pulls.
    for (let i = 0; i < 40; i++)
      add("rerun_chr_yvonne", rerunType, { isFree: i < 10 });
    for (let i = 0; i < 14; i++) add("special_test", specialType);
    for (const pool of [
      "rerun_chr_yvonne",
      "rerun_chr_other",
      "special_test",
    ]) {
      await db.set(`GACHA_POOL_METADATA_${pool}`, {
        data: {
          up6_name: "UP",
          all: [{ id: "chr_up", name: "UP", rarity: 6 }],
        },
      });
    }
    const requested = new Set<string>();
    axios.get = (async (url: string, options: any) => {
      if (url.endsWith("/api/record/weapon/pool"))
        return { data: { code: 0, data: [] } };
      assert.ok(url.endsWith("/api/record/char"));
      const type = options.params.pool_type;
      requested.add(type);
      return {
        data: {
          code: 0,
          data: {
            list: records.filter((r) => r.poolType === type).reverse(),
            hasMore: false,
          },
        },
      };
    }) as typeof axios.get;
    const imported = await fetchAndMergeGachaLog(
      db,
      "https://ef-webview.gryphline.com/?token=test&server_id=2",
      undefined,
      "test",
    );
    assert.ok(
      requested.has(rerunType),
      "imports must request reconstructed headhunting",
    );
    assert.equal(imported.totalChar, 54);
    const stats = await getGachaStats(db, imported.data);
    assert.equal(stats.char.summary.RerunShared.currentPity, 30);
    assert.equal(stats.char.summary.RerunShared.nonFreeTotal, 30);
    assert.equal(stats.char.summary.RerunShared.freeTotal, 10);
    assert.equal(stats.char.summary.SpecialShared.currentPity, 14);
    assert.equal(
      stats.char.pools.find((p) => p.id === "rerun_chr_yvonne")?.total,
      30,
    );
    const leaderboard = await db.get("GACHA_LB.test");
    assert.equal(leaderboard.stats.RerunShared.total, 30);
    assert.equal(leaderboard.stats.rerun_chr_yvonne.total, 30);
    const importedAgain = await fetchAndMergeGachaLog(
      db,
      "https://ef-webview.gryphline.com/?token=test&server_id=2",
      undefined,
      "test",
    );
    assert.equal(
      importedAgain.totalChar,
      54,
      "reimport must not duplicate rerun records",
    );

    // Rerun pools share their own 80-pull pity; Special pulls never enter it.
    add("rerun_chr_other", rerunType, {
      rarity: 6,
      charId: "chr_up",
      charName: "UP",
    });
    add("rerun_chr_other", rerunType, {
      rarity: 6,
      charId: "chr_0015_lifeng",
      charName: "Off-rate",
    });
    const after = await getGachaStats(db, {
      ...imported.data,
      characterList: [...records].reverse(),
    });
    const up = after.char.history.find((r) => r.charId === "chr_up");
    assert.equal(up.pitySixCount, 31);
    assert.equal(up.isFeatured, true);
    assert.equal(
      after.char.history.find((r) => r.charId === "chr_0015_lifeng").isOffRate,
      true,
    );
    assert.equal(after.char.summary.RerunShared.currentPity, 0);
    assert.equal(after.char.summary.SpecialShared.currentPity, 14);
    console.log(
      "Rerun import, pity, rate-up and leaderboard regression tests passed",
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
