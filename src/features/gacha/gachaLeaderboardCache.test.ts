import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import {
  deduplicateLeaderboardAliases,
  LEADERBOARD_CACHE_TTL_MS,
  lbKey,
  noteLeaderboardGuild,
  readLeaderboardEntries,
  removeLeaderboardEntry,
  updateLeaderboard,
} from "./gachaLeaderboard";
import { clearGachaLog, migrateGachaLog } from "./gachaStore";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord } from "./gachaTypes";

const POOL = "special_cache_test";

function rec(seq: number): GachaRecord {
  return {
    seqId: String(seq),
    gachaTs: String(1700000000000 + seq * 1000),
    poolId: POOL,
    poolName: "Pool",
    poolType: "E_CharacterGachaPoolType_Special",
    isFree: false,
    rarity: 4,
    charId: "chr_x",
    charName: "X",
    kind: "draw",
  };
}

function logOf(uid: string, seqs: number[], serverId = "2", updatedAt?: number): GachaLogData {
  return {
    characterList: seqs.map(rec),
    weaponList: [],
    info: { uid, lang: "en-us", serverId, export_timestamp: 1, ...(updatedAt ? { updatedAt } : {}) },
  };
}

function entry(uid: string, over: Partial<GachaLeaderboardEntry> = {}): GachaLeaderboardEntry {
  return {
    uid,
    nickname: uid,
    lastUpdate: 1700000000000,
    total: 10,
    nonFreeTotal: 10,
    freeTotal: 0,
    stats: { TOTAL: { total: 10, sixStarCount: 1, fiveStarCount: 1, probability: 0.1 } },
    guilds: [],
    updatedAt: 1,
    ...over,
  };
}

/** Counts reads of the board rows and of full log rows. */
function counting(real: CustomDatabase) {
  const counts = { board: 0, logGets: 0 };
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "findByPrefix")
        return (...a: any[]) => {
          counts.board++;
          return (target as any).findByPrefix(...a);
        };
      if (prop === "get")
        return (key: string) => {
          if (key.startsWith("GACHA_LOG_")) counts.logGets++;
          return target.get(key);
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as CustomDatabase;
  return { db, counts };
}

async function testBoardCache() {
  const real = new CustomDatabase(":memory:");
  await real.set(`GACHA_POOL_METADATA_${POOL}`, { data: {} });
  await real.set("GACHA_LOG_EF_1", logOf("EF_1", [1, 2, 3]));
  await real.set(lbKey("EF_1"), entry("EF_1"));
  await real.set(lbKey("EF_2"), entry("EF_2"));
  const { db, counts } = counting(real);

  const t0 = 1_800_000_000_000;
  const first = await readLeaderboardEntries(db, { now: t0 });
  assert.equal(first.length, 2);
  assert.equal(counts.board, 1);
  const second = await readLeaderboardEntries(db, { now: t0 + 1000 });
  assert.equal(counts.board, 1, "served from the process cache");
  assert.equal(second.length, 2);

  // callers mutate their copy; nobody else sees it
  second[0].avatarUrl = "https://example.com/x.png";
  const third = await readLeaderboardEntries(db, { now: t0 + 2000 });
  assert.equal(third[0].avatarUrl, undefined);

  // TTL
  await readLeaderboardEntries(db, { now: t0 + LEADERBOARD_CACHE_TTL_MS + 1 });
  assert.equal(counts.board, 2, "re-read after 60 s");

  // a row written by ANOTHER process is not seen until the TTL (documented)
  await real.set(lbKey("EF_3"), entry("EF_3"));
  assert.equal((await readLeaderboardEntries(db, { now: t0 + LEADERBOARD_CACHE_TTL_MS + 2 })).length, 2);
  assert.equal((await readLeaderboardEntries(db, { fresh: true })).length, 3);

  // every write path of THIS process invalidates at once
  const board = async () => (await readLeaderboardEntries(db)).map((e) => e.uid).sort();
  await board();
  const before = counts.board;

  await real.set(`GACHA_LOG_EF_9`, logOf("EF_9", [1, 2]));
  await updateLeaderboard(db, "EF_9", logOf("EF_9", [1, 2]));
  assert.ok((await board()).includes("EF_9"), "updateLeaderboard invalidates");
  assert.ok(counts.board > before);

  assert.equal(noteLeaderboardGuild(db, "EF_9", "guild-1"), true);
  const afterGuild = (await readLeaderboardEntries(db)).find((e) => e.uid === "EF_9")!;
  assert.deepEqual(afterGuild.guilds, ["guild-1"], "noteLeaderboardGuild invalidates");
  const reads = counts.board;
  assert.equal(noteLeaderboardGuild(db, "EF_9", "guild-1"), false);
  await readLeaderboardEntries(db);
  assert.equal(counts.board, reads, "an unchanged guild list does not invalidate");

  await removeLeaderboardEntry(db, "EF_9");
  assert.ok(!(await board()).includes("EF_9"), "removeLeaderboardEntry invalidates");

  // clear (deletes the row with the log) and migrate (moves it)
  await real.set("GACHA_LOG_EF_5", logOf("EF_5", [1]));
  await updateLeaderboard(db, "EF_5", logOf("EF_5", [1]));
  assert.ok((await board()).includes("EF_5"));
  await clearGachaLog(db, "EF_5");
  assert.ok(!(await board()).includes("EF_5"), "clearGachaLog invalidates");

  await real.set("GACHA_LOG_EF_GUEST_1_a", logOf("EF_GUEST_1_a", [10, 11]));
  await real.set("GACHA_LOG_EF_6", logOf("EF_6", [1]));
  await migrateGachaLog(db, "EF_GUEST_1_a", "EF_6");
  assert.ok((await board()).includes("EF_6"), "migrateGachaLog invalidates");
  real.close();
}

async function testVerdictCache() {
  const real = new CustomDatabase(":memory:");
  const { db, counts } = counting(real);
  const both = (g: string, c: string) => ({ [g]: entry(g), [c]: entry(c) });

  await real.set("GACHA_LOG_EF_7", logOf("EF_7", [1, 2]));
  await real.set("GACHA_LOG_EF_CN_7", logOf("EF_CN_7", [1, 2, 3]));
  let out = await deduplicateLeaderboardAliases(db, both("EF_7", "EF_CN_7"));
  assert.deepEqual(Object.keys(out), ["EF_CN_7"]);
  assert.equal(counts.logGets, 2);

  // second pass: same outcome, no log parsed
  out = await deduplicateLeaderboardAliases(db, both("EF_7", "EF_CN_7"));
  assert.deepEqual(Object.keys(out), ["EF_CN_7"]);
  assert.equal(counts.logGets, 2, "verdict cached");

  // the board rows may change (tie-break uses lastUpdate) without a re-parse
  await real.set("GACHA_LOG_EF_8", logOf("EF_8", [1, 2]));
  await real.set("GACHA_LOG_EF_CN_8", logOf("EF_CN_8", [1, 2]));
  const e8 = both("EF_8", "EF_CN_8");
  e8.EF_8.lastUpdate = 10;
  e8.EF_CN_8.lastUpdate = 20;
  out = await deduplicateLeaderboardAliases(db, e8);
  assert.deepEqual(Object.keys(out), ["EF_CN_8"]);
  const gets = counts.logGets;
  e8.EF_8.lastUpdate = 30;
  out = await deduplicateLeaderboardAliases(db, e8);
  assert.deepEqual(Object.keys(out), ["EF_8"], "tie-break follows the rows, not the cache");
  assert.equal(counts.logGets, gets);

  // a changed log (legacy row: no updatedAt, so only the stored length changes) is re-evaluated
  await real.set("GACHA_LOG_EF_7", logOf("EF_7", [1, 2, 3, 4]));
  out = await deduplicateLeaderboardAliases(db, both("EF_7", "EF_CN_7"));
  assert.deepEqual(Object.keys(out), ["EF_7"], "now the CN log is the subset");
  assert.equal(counts.logGets, gets + 2);

  // same length, new updatedAt: also re-evaluated
  await real.set("GACHA_LOG_EF_10", logOf("EF_10", [1, 5], "2", 1000));
  await real.set("GACHA_LOG_EF_CN_10", logOf("EF_CN_10", [1, 6], "2", 1000));
  out = await deduplicateLeaderboardAliases(db, both("EF_10", "EF_CN_10"));
  assert.equal(Object.keys(out).length, 2, "two different people");
  const g10 = counts.logGets;
  await real.set("GACHA_LOG_EF_CN_10", logOf("EF_CN_10", [1, 5], "2", 1001));
  out = await deduplicateLeaderboardAliases(db, both("EF_10", "EF_CN_10"));
  assert.equal(Object.keys(out).length, 1, "same records now: one of them goes");
  assert.equal(counts.logGets, g10 + 2);

  // a missing log means "not comparable" and is not cached as a verdict
  await real.set("GACHA_LOG_EF_11", logOf("EF_11", [1]));
  out = await deduplicateLeaderboardAliases(db, both("EF_11", "EF_CN_11"));
  assert.equal(Object.keys(out).length, 2);
  await real.set("GACHA_LOG_EF_CN_11", logOf("EF_CN_11", [1, 2]));
  out = await deduplicateLeaderboardAliases(db, both("EF_11", "EF_CN_11"));
  assert.deepEqual(Object.keys(out), ["EF_CN_11"]);

  // a database without getRowToken still works (no caching)
  const plain = { get: (k: string) => real.get(k) };
  out = await deduplicateLeaderboardAliases(plain, both("EF_7", "EF_CN_7"));
  assert.deepEqual(Object.keys(out), ["EF_7"]);
  real.close();
}

async function testBoardAppliesDedup() {
  const real = new CustomDatabase(":memory:");
  await real.set("GACHA_LOG_EF_20", logOf("EF_20", [1, 2]));
  await real.set("GACHA_LOG_EF_CN_20", logOf("EF_CN_20", [1, 2, 3]));
  await real.set(lbKey("EF_20"), entry("EF_20"));
  await real.set(lbKey("EF_CN_20"), entry("EF_CN_20"));
  await real.set(lbKey("EF_21"), entry("EF_21"));
  const uids = (await readLeaderboardEntries(real)).map((e) => e.uid).sort();
  assert.deepEqual(uids, ["EF_21", "EF_CN_20"]);
  real.close();
}

async function main() {
  await testBoardCache();
  await testVerdictCache();
  await testBoardAppliesDedup();
  console.log("gacha leaderboard cache tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
