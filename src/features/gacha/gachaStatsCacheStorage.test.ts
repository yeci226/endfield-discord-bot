import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import {
  decodeStatsPayload,
  deleteStaleStatsCache,
  getCachedGachaStats,
  isStatsRowStale,
  makeStatsToken,
  STATS_CACHE_MAX_AGE_MS,
  STATS_CACHE_PREFIX,
  STATS_MEMORY_TTL_MS,
  StatsMemoryCache,
  statsMemoryFor,
} from "./gachaStatsCache";
import { ENGINE_VERSION } from "./gachaStatsEngine";
import { startGachaStorageJobs } from "./gachaLeaderboard";

function logRow(n: number, updatedAt?: number) {
  return {
    characterList: Array.from({ length: n }, (_, i) => ({ seqId: String(i) })),
    weaponList: [],
    info: { uid: "EF_1", lang: "tw", nickname: "N", ...(updatedAt ? { updatedAt } : {}) },
  };
}

function spyDb() {
  const real = new CustomDatabase(":memory:");
  const reads: string[] = [];
  const writes: string[] = [];
  const db: any = {
    real,
    reads,
    writes,
    get: async (k: string) => (reads.push(k), real.get(k)),
    set: async (k: string, v: any) => (writes.push(k), real.set(k, v)),
    delete: async (k: string) => (writes.push("del:" + k), real.delete(k)),
    getRowToken: (k: string, p?: string) => real.getRowToken(k, p),
  };
  return db;
}

function bigStats(n: number) {
  return {
    char: {
      history: Array.from({ length: n }, (_, i) => ({
        seqId: i,
        name: "Operator " + (i % 40),
        pity: i % 80,
      })),
    },
    weapon: {},
  };
}

async function testCompressedRow() {
  const db = spyDb();
  await db.real.set("GACHA_LOG_EF_Z", logRow(50, 7));
  const stats = bigStats(3000);
  await getCachedGachaStats(db, "GACHA_LOG_EF_Z", async () => stats);
  const key = STATS_CACHE_PREFIX + "GACHA_LOG_EF_Z";
  const row: any = await db.real.get(key);
  assert.equal(row.engine, ENGINE_VERSION);
  assert.equal(typeof row.token, "string");
  assert.equal(typeof row.computedAt, "number");
  assert.equal(row.stats, undefined, "stats are only inside the compressed payload");
  assert.ok(typeof row.payload === "string");
  const rawLen = JSON.stringify({ info: logRow(50, 7).info, stats }).length;
  assert.ok(
    db.real.getRowToken(key)!.length < rawLen / 3,
    "row is several times smaller than the JSON",
  );
  assert.deepEqual((await decodeStatsPayload<any>(row.payload)).stats, stats);
  // header fields are readable by SQL without parsing the row
  assert.equal(db.real.getRowToken(key, "$.engine")!.field, String(ENGINE_VERSION));

  // a cold process reads it back through the DB and serves the same stats
  statsMemoryFor(db).clear();
  const hit = await getCachedGachaStats(db, "GACHA_LOG_EF_Z", async () => {
    throw new Error("must not compute");
  });
  assert.equal(hit!.hit, true);
  assert.deepEqual(hit!.stats, stats);

  // a row in the old uncompressed shape is a miss and is overwritten
  const log = db.real.getRowToken("GACHA_LOG_EF_Z", "$.info.updatedAt")!;
  await db.real.set(key, {
    engine: ENGINE_VERSION,
    token: makeStatsToken(log),
    computedAt: Date.now(),
    info: logRow(50, 7).info,
    stats: { old: true },
  });
  statsMemoryFor(db).clear();
  let computes = 0;
  const r = await getCachedGachaStats(db, "GACHA_LOG_EF_Z", async () => ({
    fresh: ++computes,
  }));
  assert.equal(r!.hit, false);
  assert.equal(computes, 1);
  assert.equal(((await db.real.get(key)) as any).stats, undefined, "overwritten in the new shape");

  // a corrupt payload is a miss too
  const bad: any = await db.real.get(key);
  bad.payload = "bm90IGJyb3RsaQ==";
  await db.real.set(key, bad);
  statsMemoryFor(db).clear();
  const r2 = await getCachedGachaStats(db, "GACHA_LOG_EF_Z", async () => ({
    fresh: ++computes,
  }));
  assert.equal(r2!.hit, false);
}

async function testMemoryLru() {
  const entry = (bytes: number) => ({
    stats: {},
    info: {} as any,
    bytes,
    computedAt: 0,
    unknown: 0,
  });
  const m = new StatsMemoryCache(3, 1000, 1000);
  m.set("a", entry(100), 0);
  m.set("b", entry(100), 0);
  m.set("c", entry(100), 0);
  assert.ok(m.get("a", 1)); // a is now the most recent
  m.set("d", entry(100), 2);
  assert.equal(m.get("b", 3), undefined, "least recently used goes first");
  assert.ok(m.get("a", 3) && m.get("c", 3) && m.get("d", 3));
  assert.equal(m.size, 3);
  m.set("big", entry(950), 4);
  assert.equal(m.size, 1, "byte cap evicts down to the new entry");
  assert.equal(m.bytes, 950);
  m.set("e", entry(10), 5);
  m.set("f", entry(10), 5);
  assert.ok(m.bytes <= 1000);
  const t = new StatsMemoryCache(5, 1e9, 1000);
  t.set("x", entry(1), 0);
  assert.ok(t.get("x", 999));
  assert.equal(t.get("x", 1000), undefined, "expired by TTL");
  assert.equal(t.bytes, 0);
  assert.equal(STATS_MEMORY_TTL_MS, 15 * 60 * 1000);
  assert.equal(new StatsMemoryCache().maxEntries, 24);

  // integration: keyed by log + token; repeat views read no cache row
  const db = spyDb();
  await db.real.set("GACHA_LOG_EF_M", logRow(4, 1));
  await db.real.set("GACHA_LOG_EF_N", logRow(4, 1));
  let computes = 0;
  await getCachedGachaStats(db, "GACHA_LOG_EF_M", async () => ({ who: "M", n: ++computes }));
  await getCachedGachaStats(db, "GACHA_LOG_EF_N", async () => ({ who: "N", n: ++computes }));
  db.reads.length = 0;
  db.writes.length = 0;
  const m1 = await getCachedGachaStats(db, "GACHA_LOG_EF_M", async () => ({ who: "X" }));
  const n1 = await getCachedGachaStats(db, "GACHA_LOG_EF_N", async () => ({ who: "X" }));
  assert.equal((m1!.stats as any).who, "M");
  assert.equal((n1!.stats as any).who, "N", "never another log's stats");
  assert.deepEqual(db.reads, [], "memory hit reads nothing but the version token");
  assert.deepEqual(db.writes, []);
  // the log changed (new token): the memory copy is not served
  await db.real.set("GACHA_LOG_EF_M", logRow(5, 2));
  const m2 = await getCachedGachaStats(db, "GACHA_LOG_EF_M", async () => ({ who: "M2" }));
  assert.equal(m2!.hit, false);
  assert.equal((m2!.stats as any).who, "M2");
  // TTL: after 15 minutes the memory copy is dropped (the DB row still serves)
  const later = Date.now() + STATS_MEMORY_TTL_MS + 1000;
  db.reads.length = 0;
  const m3 = await getCachedGachaStats(
    db,
    "GACHA_LOG_EF_M",
    async () => ({ who: "never" }),
    later,
  );
  assert.equal(m3!.hit, true);
  assert.ok(db.reads.includes(STATS_CACHE_PREFIX + "GACHA_LOG_EF_M"));
}

async function testFrozenAndShared() {
  const db = spyDb();
  await db.real.set("GACHA_LOG_EF_F", logRow(3, 9));
  const a = await getCachedGachaStats(db, "GACHA_LOG_EF_F", async () => ({
    list: [1, 2, 3],
  }));
  assert.ok(Object.isFrozen(a!.stats));
  assert.ok(Object.isFrozen(a!.info));
  assert.throws(() => {
    "use strict";
    (a!.stats as any).added = 1;
  }, TypeError);
  const b = await getCachedGachaStats(db, "GACHA_LOG_EF_F", async () => ({ list: [] }));
  assert.equal(b!.stats, a!.stats, "shared object between views");
  statsMemoryFor(db).clear();
  const c = await getCachedGachaStats(db, "GACHA_LOG_EF_F", async () => ({ list: [] }));
  assert.ok(Object.isFrozen(c!.stats), "also when read back from the DB");
}

async function testRetention() {
  const now = 2_000_000_000_000;
  assert.equal(isStatsRowStale(now - STATS_CACHE_MAX_AGE_MS - 1, now), true);
  assert.equal(isStatsRowStale(now - STATS_CACHE_MAX_AGE_MS + 1000, now), false);
  assert.equal(isStatsRowStale(undefined, now), true, "old-shape row without computedAt");
  assert.equal(isStatsRowStale(null, now), true);

  const real = new CustomDatabase(":memory:");
  const day = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 12; i++)
    await real.set(STATS_CACHE_PREFIX + "GACHA_LOG_R" + String(i).padStart(2, "0"), {
      engine: 1,
      token: "x",
      computedAt: now - (i < 7 ? 40 * day : 5 * day),
      payload: "x".repeat(2000),
    });
  await real.set(STATS_CACHE_PREFIX + "GACHA_LOG_OLDSHAPE", {
    engine: 1,
    token: "x",
    stats: {},
  });
  await real.set("GACHA_LOG_R00", { info: {} }); // a log row must never be touched
  let fullReads = 0;
  const wrapped: any = {
    scanFieldsByPrefix: (...a: any[]) => (real.scanFieldsByPrefix as any)(...a),
    deleteIds: (ids: string[]) => real.deleteIds(ids),
    get: () => fullReads++,
  };
  // at most 5 deletions per run
  let res = await deleteStaleStatsCache(wrapped, { now, maxDeletes: 5, scanBatch: 4 });
  assert.equal(res.deleted, 5);
  res = await deleteStaleStatsCache(wrapped, { now, maxDeletes: 500, scanBatch: 4 });
  const left = real.findKeysByPrefix(STATS_CACHE_PREFIX);
  assert.equal(left.length, 5, "only the five fresh rows remain");
  assert.ok(left.every((k) => k >= STATS_CACHE_PREFIX + "GACHA_LOG_R07"));
  assert.ok(
    !left.includes(STATS_CACHE_PREFIX + "GACHA_LOG_OLDSHAPE"),
    "a row without computedAt is expired",
  );
  assert.ok(real.getRowToken("GACHA_LOG_R00"), "log rows untouched");
  assert.equal(fullReads, 0);
  res = await deleteStaleStatsCache(wrapped, { now });
  assert.equal(res.deleted, 0);
}

function testJobRegistered() {
  const jobs: Array<[string, number | null]> = [];
  startGachaStorageJobs(
    {
      onPrimary: (name) => void jobs.push([name, null]),
      every: (name, ms) => void jobs.push([name, ms]),
    },
    new CustomDatabase(":memory:"),
  );
  assert.ok(
    jobs.some(([n, ms]) => n === "gacha-stats-cache-retention" && ms === 60 * 60 * 1000),
    "hourly retention job registered by startGachaStorageJobs",
  );
}

async function main() {
  testJobRegistered();
  await testCompressedRow();
  await testMemoryLru();
  await testFrozenAndShared();
  await testRetention();
  console.log("gacha stats cache storage tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
