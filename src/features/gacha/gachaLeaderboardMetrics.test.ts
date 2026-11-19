import assert from "node:assert/strict";
import axios from "axios";
import { CustomDatabase } from "../../utils/Database";
import {
  MIN_PULLS_FOR_LUCK_RANK,
  computeLeaderboardMetrics,
  isRankableStat,
  rankLeaderboard,
  sixStarRate,
} from "./gachaLeaderboard";
import { getGachaStats } from "./gachaStatsEngine";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord } from "./gachaTypes";

function stat(total: number, six: number, five = 0) {
  return {
    total,
    sixStarCount: six,
    fiveStarCount: five,
    probability: sixStarRate(six, total),
  };
}

function entry(uid: string, total: number, six: number): GachaLeaderboardEntry {
  return {
    uid,
    nickname: uid,
    lastUpdate: 0,
    total,
    nonFreeTotal: total,
    freeTotal: 0,
    stats: { TOTAL: stat(total, six) },
  };
}

async function testMetricsIgnoreFreeSixStars() {
  const db = new CustomDatabase(":memory:");
  const originalGet = axios.get;
  try {
    const records: GachaRecord[] = [];
    const add = (poolId: string, fields: Partial<GachaRecord> = {}) =>
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
    for (let i = 1; i <= 70; i++) add("previous", { rarity: i === 54 ? 6 : 4 });
    for (let i = 0; i < 10; i++) add("current", { isFree: true, rarity: 6 });
    for (let i = 1; i <= 60; i++) add("current", { rarity: i === 46 ? 6 : 4 });
    const data: GachaLogData = {
      characterList: [...records].reverse(),
      weaponList: [],
      info: { uid: "t", lang: "en-us", export_timestamp: 0 },
    };
    for (const p of ["previous", "current"])
      await db.set(`GACHA_POOL_METADATA_${p}`, { data: {} });
    axios.get = (async () => {
      throw new Error("no network");
    }) as typeof axios.get;

    const stats = await getGachaStats(db, data);
    // The raw summary counts the 10 free 6-stars too: this is the number the old board used.
    assert.equal(stats.char.summary.SpecialShared.sixStarCount, 12);

    const m = computeLeaderboardMetrics(stats, data);
    assert.equal(m.nonFreeTotal, 130);
    assert.equal(m.freeTotal, 10);
    assert.equal(m.stats.TOTAL.total, 130);
    assert.equal(m.stats.TOTAL.sixStarCount, 2, "free 6-stars are not counted");
    assert.equal(m.stats.TOTAL.probability, 2 / 130);
    assert.equal(m.stats.SpecialShared.sixStarCount, 2);
    assert.equal(m.stats.SpecialShared.probability, 2 / 130);
    // per-pool rows were already non-free and stay so
    assert.equal(m.stats.current.sixStarCount, 1);
    assert.equal(m.stats.current.total, 60);
    assert.equal(m.stats.previous.sixStarCount, 1);
  } finally {
    axios.get = originalGet;
    db.close();
  }
}

function testRateDefinition() {
  assert.equal(sixStarRate(0, 0), 0);
  assert.equal(sixStarRate(3, 0), 0, "no non-free pulls never divides by zero");
  assert.equal(sixStarRate(2, 100), 0.02);
}

function testLuckNeedsEnoughPulls() {
  assert.equal(MIN_PULLS_FOR_LUCK_RANK, 100);
  assert.equal(isRankableStat(stat(1, 1), "luck"), false);
  assert.equal(isRankableStat(stat(99, 5), "luck"), false);
  assert.equal(isRankableStat(stat(100, 0), "luck"), true, "exactly 100 counts, even with no 6-star");
  assert.equal(isRankableStat(stat(1, 1), "pulls"), true, "no minimum for total pulls");
  assert.equal(isRankableStat(stat(0, 0), "pulls"), false, "nobody with zero pulls is listed");
  assert.equal(isRankableStat(undefined, "luck"), false);

  const entries = [
    entry("lucky1", 1, 1), // 100% on one pull: the old board put this first
    entry("a", 100, 3),
    entry("b", 200, 4),
    entry("c", 99, 9),
    entry("d", 150, 0),
  ];
  const luck = rankLeaderboard(entries, "TOTAL", "luck");
  assert.deepEqual(luck.map((r) => r.entry.uid), ["a", "b", "d"]);
  assert.deepEqual(luck.map((r) => r.rank), [1, 2, 3]);
  const pulls = rankLeaderboard(entries, "TOTAL", "pulls");
  assert.deepEqual(pulls.map((r) => r.entry.uid), ["b", "d", "a", "c", "lucky1"]);
}

function testDeterministicOrder() {
  const entries = [
    entry("z", 200, 4),
    entry("m", 200, 4),
    entry("a", 200, 4),
    entry("big", 400, 8),
  ];
  const first = rankLeaderboard(entries, "TOTAL", "luck").map((r) => r.entry.uid);
  const second = rankLeaderboard([...entries].reverse(), "TOTAL", "luck").map(
    (r) => r.entry.uid,
  );
  assert.deepEqual(first, second, "input order never changes the ranking");
  assert.deepEqual(first, ["big", "a", "m", "z"], "ties: more pulls first, then uid");
}

function testOtherPools() {
  const e = entry("p", 300, 3);
  e.stats.SpecialShared = stat(40, 1);
  const r = rankLeaderboard([e], "SpecialShared", "luck");
  assert.equal(r.length, 0, "only 40 pulls in that category");
  assert.equal(rankLeaderboard([e], "SpecialShared", "pulls").length, 1);
  assert.equal(rankLeaderboard([e], "NoSuchPool", "pulls").length, 0);
}

async function main() {
  testRateDefinition();
  testLuckNeedsEnoughPulls();
  testDeterministicOrder();
  testOtherPools();
  await testMetricsIgnoreFreeSixStars();
  console.log("Gacha leaderboard metrics tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
