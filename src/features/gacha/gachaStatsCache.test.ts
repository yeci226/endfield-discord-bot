import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import {
  getCachedGachaStats,
  makeStatsToken,
  STATS_CACHE_PREFIX,
  UNKNOWN_FEATURED_TTL_MS,
} from "./gachaStatsCache";
import { ENGINE_VERSION } from "./gachaStatsEngine";

function logRow(n: number, updatedAt?: number) {
  return {
    characterList: Array.from({ length: n }, (_, i) => ({ seqId: String(i) })),
    weaponList: [],
    info: { uid: "EF_1", lang: "tw", nickname: "N", ...(updatedAt ? { updatedAt } : {}) },
  };
}

/** Real in-memory DB that records which keys were read in full. */
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

async function main() {
  // --- getRowToken -------------------------------------------------------
  {
    const db = new CustomDatabase(":memory:");
    assert.equal(db.getRowToken("missing"), null);
    await db.set("a", { info: { updatedAt: 1700 } });
    const t = db.getRowToken("a", "$.info.updatedAt")!;
    assert.equal(t.field, "1700");
    assert.equal(t.length, JSON.stringify({ info: { updatedAt: 1700 } }).length);
    assert.equal(db.getRowToken("a", "$.info.nothing")!.field, null);
    assert.equal(db.getRowToken("a")!.field, null);
    // non-JSON row: still has a length, json_extract failure is swallowed
    (db as any).db.prepare("INSERT INTO json (ID, json) VALUES (?, ?)").run("bad", "{oops");
    assert.deepEqual(db.getRowToken("bad", "$.x"), { length: 5, field: null });
    // multibyte text: length changes when content changes
    await db.set("cjk", { n: "羽冰" });
    const before = db.getRowToken("cjk")!.length;
    await db.set("cjk", { n: "羽冰羽" });
    assert.ok(db.getRowToken("cjk")!.length > before);
  }

  // --- token -------------------------------------------------------------
  assert.equal(makeStatsToken({ length: 12, field: "99" }), "12:99");
  assert.equal(makeStatsToken({ length: 12, field: null }), "12:");

  // --- hit does not call compute and does not read the log row ----------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_1", logRow(5));
    let computes = 0;
    const compute = async (data: any) => {
      computes++;
      return { total: data.characterList.length };
    };
    const first = await getCachedGachaStats(db, "GACHA_LOG_EF_1", compute);
    assert.equal(first!.hit, false);
    assert.deepEqual(first!.stats, { total: 5 });
    assert.equal(first!.info.nickname, "N");
    assert.equal(computes, 1);
    assert.deepEqual(db.writes, [STATS_CACHE_PREFIX + "GACHA_LOG_EF_1"]);

    db.reads.length = 0;
    db.writes.length = 0;
    const second = await getCachedGachaStats(db, "GACHA_LOG_EF_1", compute);
    assert.equal(second!.hit, true);
    assert.deepEqual(second!.stats, { total: 5 });
    assert.equal(computes, 1, "hit must not call compute");
    assert.ok(!db.reads.includes("GACHA_LOG_EF_1"), "hit must not read the log row");
    assert.deepEqual(db.writes, [], "hit must not write");

    // --- changed length misses -------------------------------------------
    await db.real.set("GACHA_LOG_EF_1", logRow(6));
    const third = await getCachedGachaStats(db, "GACHA_LOG_EF_1", compute);
    assert.equal(third!.hit, false);
    assert.deepEqual(third!.stats, { total: 6 });
    assert.equal(computes, 2);
  }

  // --- changed updatedAt with identical length misses -------------------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_2", logRow(3, 1_700_000_000_001));
    let computes = 0;
    const compute = async () => ({ n: ++computes });
    await getCachedGachaStats(db, "GACHA_LOG_EF_2", compute);
    await db.real.set("GACHA_LOG_EF_2", logRow(3, 1_700_000_000_002));
    assert.equal(
      db.real.getRowToken("GACHA_LOG_EF_2")!.length,
      JSON.stringify(logRow(3, 1_700_000_000_001)).length,
      "precondition: same length",
    );
    const r = await getCachedGachaStats(db, "GACHA_LOG_EF_2", compute);
    assert.equal(r!.hit, false);
    assert.equal(computes, 2);
  }

  // --- engine bump misses ------------------------------------------------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_3", logRow(2));
    let computes = 0;
    await getCachedGachaStats(db, "GACHA_LOG_EF_3", async () => ({ n: ++computes }));
    const key = STATS_CACHE_PREFIX + "GACHA_LOG_EF_3";
    const entry: any = await db.real.get(key);
    assert.equal(entry.engine, ENGINE_VERSION);
    entry.engine = ENGINE_VERSION - 1;
    await db.real.set(key, entry);
    const r = await getCachedGachaStats(db, "GACHA_LOG_EF_3", async () => ({ n: ++computes }));
    assert.equal(r!.hit, false);
    assert.equal(computes, 2);
  }

  // --- different log keys never share an entry --------------------------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_A", logRow(4));
    await db.real.set("GACHA_LOG_EF_B", logRow(4)); // same length, same token
    const a = await getCachedGachaStats(db, "GACHA_LOG_EF_A", async () => ({ who: "A" }));
    const b = await getCachedGachaStats(db, "GACHA_LOG_EF_B", async () => ({ who: "B" }));
    assert.deepEqual(a!.stats, { who: "A" });
    assert.deepEqual(b!.stats, { who: "B" });
    assert.equal(b!.hit, false);
    const a2 = await getCachedGachaStats(db, "GACHA_LOG_EF_A", async () => ({ who: "X" }));
    assert.deepEqual(a2!.stats, { who: "A" });
  }

  // --- deleted log row removes its cache row ----------------------------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_4", logRow(2));
    await getCachedGachaStats(db, "GACHA_LOG_EF_4", async () => ({ n: 1 }));
    const key = STATS_CACHE_PREFIX + "GACHA_LOG_EF_4";
    assert.ok(db.real.getRowToken(key));
    await db.real.delete("GACHA_LOG_EF_4");
    let computes = 0;
    const r = await getCachedGachaStats(db, "GACHA_LOG_EF_4", async () => ({ n: ++computes }));
    assert.equal(r, null);
    assert.equal(computes, 0);
    assert.equal(db.real.getRowToken(key), null, "orphan cache row removed");
    // a missing log with no cache row performs no write at all
    db.writes.length = 0;
    assert.equal(await getCachedGachaStats(db, "GACHA_LOG_EF_NONE", async () => ({})), null);
    assert.deepEqual(db.writes, []);
  }

  // --- stats with unknown featured 6* expire (pool metadata may arrive later) -
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_5", logRow(2));
    let computes = 0;
    const compute = async () => ({ char: { unknownFeaturedCount: 1 }, weapon: {}, n: ++computes });
    const t0 = 1_800_000_000_000;
    await getCachedGachaStats(db, "GACHA_LOG_EF_5", compute, t0);
    let r = await getCachedGachaStats(db, "GACHA_LOG_EF_5", compute, t0 + 1000);
    assert.equal(r!.hit, true);
    r = await getCachedGachaStats(db, "GACHA_LOG_EF_5", compute, t0 + UNKNOWN_FEATURED_TTL_MS + 1);
    assert.equal(r!.hit, false);
    assert.equal(computes, 2);
  }

  // --- a failing cache write never fails the view ----------------------------------
  {
    const db = spyDb();
    await db.real.set("GACHA_LOG_EF_6", logRow(2));
    db.set = async () => {
      throw new Error("database is locked");
    };
    const r = await getCachedGachaStats(db, "GACHA_LOG_EF_6", async () => ({ ok: 1 }));
    assert.deepEqual(r!.stats, { ok: 1 });
  }

  console.log("gacha stats cache tests passed");
}

void main();
