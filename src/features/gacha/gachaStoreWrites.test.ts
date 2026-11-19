import assert from "node:assert/strict";
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import { CustomDatabase } from "../../utils/Database";
import {
  clearGachaLog,
  commitFetchedGachaLog,
  fetchAndMergeGachaLog,
  mergePityResetMarkers,
  migrateGachaLog,
  nextUpdatedAt,
} from "./gachaStore";
import { lbKey, noteLeaderboardGuild } from "./gachaLeaderboard";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord } from "./gachaTypes";
import { getGachaStats } from "./gachaStatsEngine";

const POOL = "special_1_0_1";
const TYPE = "E_CharacterGachaPoolType_Special";

function rec(seq: number, over: Partial<GachaRecord> = {}): GachaRecord {
  return {
    seqId: String(seq),
    gachaTs: String(1700000000000 + seq * 1000),
    poolId: POOL,
    poolName: "Test pool",
    poolType: TYPE,
    isFree: false,
    rarity: 4,
    charId: "chr_x",
    charName: "X",
    kind: "draw",
    ...over,
  };
}

function raw(chars: GachaRecord[], weapons: GachaRecord[] = []) {
  return {
    host: "https://ef-webview.gryphline.com",
    lang: "en-us",
    serverId: "2",
    apiDomain: "https://ef-webview.gryphline.com",
    inferredUid: "test",
    characterList: chars,
    weaponList: weapons,
  };
}

async function primeMetadata(db: CustomDatabase, ...pools: string[]) {
  for (const p of pools) await db.set(`GACHA_POOL_METADATA_${p}`, { data: {} });
}

/** Serves `list` for the Special pool and nothing for every other endpoint. */
function stubApi(list: () => GachaRecord[], onChar?: () => void | Promise<void>) {
  axios.get = (async (url: string, config: any) => {
    if (url.endsWith("/api/record/weapon/pool"))
      return { data: { code: 0, data: [] } };
    if (!url.endsWith("/api/record/char")) throw new Error(`unexpected ${url}`);
    if (config.params.pool_type !== TYPE)
      return { data: { code: 0, data: { list: [], hasMore: false } } };
    if (onChar) await onChar();
    return { data: { code: 0, data: { list: list(), hasMore: false } } };
  }) as typeof axios.get;
}

function counts(db: CustomDatabase) {
  const c = { sets: [] as string[] };
  const real = db.transaction.bind(db);
  (db as any).transaction = (cb: any) =>
    real((store: any) =>
      cb({
        ...store,
        set: (k: string, v: unknown) => {
          c.sets.push(k);
          store.set(k, v);
        },
      }),
    );
  return c;
}

// ---------------------------------------------------------------- Task 5 ----

function testPityMarkers() {
  const lists = (chars: number[], weapons: number[] = []) => ({
    characterList: chars.map((n) => rec(n)),
    weaponList: weapons.map((n) => rec(n)),
  });

  // Carried over when the re-import has no gap of its own.
  assert.deepEqual(
    mergePityResetMarkers({ charPityResetSeqId: "20" }, lists([30, 25, 20, 10, 5])),
    { charPityResetSeqId: "20", weaponPityResetSeqId: undefined },
  );
  // A newly detected gap wins when it is later; the earlier one is dominated.
  assert.equal(
    mergePityResetMarkers(
      { charPityResetSeqId: "20" },
      lists([60, 50, 30, 20, 10]),
      { detected: { charPityResetSeqId: "50" } },
    ).charPityResetSeqId,
    "50",
  );
  // ... but a stale "detected" never lowers an existing later marker.
  assert.equal(
    mergePityResetMarkers(
      { charPityResetSeqId: "50" },
      lists([60, 50, 30, 20, 10]),
      { detected: { charPityResetSeqId: "20" } },
    ).charPityResetSeqId,
    "50",
  );
  // Dropped when the record it points at is gone (cleared range).
  assert.equal(
    mergePityResetMarkers({ charPityResetSeqId: "20" }, lists([10, 5])).charPityResetSeqId,
    undefined,
  );
  // Dropped when nothing precedes it: there is nothing to bridge.
  assert.equal(
    mergePityResetMarkers({ charPityResetSeqId: "20" }, lists([30, 25, 20])).charPityResetSeqId,
    undefined,
  );
  // Gap closed: the merge brought in records inside (last pre-gap record, marker).
  assert.equal(
    mergePityResetMarkers(
      { charPityResetSeqId: "20" },
      lists([30, 20, 15, 10]),
      { existing: lists([30, 20, 10]) },
    ).charPityResetSeqId,
    undefined,
  );
  // Gap still open: nothing new inside it.
  assert.equal(
    mergePityResetMarkers(
      { charPityResetSeqId: "20" },
      lists([40, 30, 20, 10]),
      { existing: lists([30, 20, 10]) },
    ).charPityResetSeqId,
    "20",
  );
  // Weapon and character markers are independent; junk input is ignored.
  const both = mergePityResetMarkers(
    { charPityResetSeqId: "20", weaponPityResetSeqId: "x" },
    lists([30, 20, 10], [8, 4]),
  );
  assert.equal(both.charPityResetSeqId, "20");
  assert.equal(both.weaponPityResetSeqId, undefined);
  assert.deepEqual(mergePityResetMarkers(undefined, lists([1])), {
    charPityResetSeqId: undefined,
    weaponPityResetSeqId: undefined,
  });
}

function testNextUpdatedAt() {
  assert.equal(nextUpdatedAt(undefined, 1000), 1000);
  assert.equal(nextUpdatedAt(1000, 1000), 1001, "strictly increasing even within a millisecond");
  assert.equal(nextUpdatedAt(5000, 1000), 5001, "clock going backwards cannot go back");
  assert.equal(nextUpdatedAt(NaN as any, 7), 7);
}

// ------------------------------------------------------------ Tasks 2 + 5 ----

async function testImportWritesLeaderboardAndKeepsMarkers() {
  const db = new CustomDatabase(":memory:");
  await primeMetadata(db, POOL);
  try {
    // Old-shape log: no updatedAt, no markers (Review Focus 3).
    const legacy: GachaLogData = {
      characterList: [rec(10), rec(5)],
      weaponList: [],
      info: { uid: "test", lang: "en-us", export_timestamp: 5 },
    };
    await db.set("GACHA_LOG_test", legacy);

    // Window does not overlap the old data: a gap, so the marker is set.
    stubApi(() => [rec(30), rec(25), rec(20, { rarity: 6 })]);
    const first = await fetchAndMergeGachaLog(
      db,
      "https://ef-webview.gryphline.com/?token=t&server_id=2",
      undefined,
      "test",
      undefined,
      undefined,
      "Disp",
      1,
    );
    assert.equal(first.hasDataGap, true);
    const log1 = (await db.get<GachaLogData>("GACHA_LOG_test"))!;
    assert.equal(log1.info.charPityResetSeqId, "20");
    assert.ok(log1.info.updatedAt! > 0);
    assert.equal(log1.characterList.length, 5);

    // The leaderboard row follows the import, in the same call.
    const row1 = (await db.get<GachaLeaderboardEntry>(lbKey("test")))!;
    assert.equal(row1.logUpdatedAt, log1.info.updatedAt);
    assert.equal(row1.displayName, "Disp");
    assert.equal(row1.accountIndex, 1);
    assert.equal(row1.stats.TOTAL.total, 5);
    assert.deepEqual(row1.guilds, []);
    assert.equal(await db.get("GACHA_LEADERBOARD_ENTRIES"), null, "blob is never written");

    // Re-import: no new gap, yet the marker survives (Task 5).
    await noteLeaderboardGuild(db, "test", "guild-1");
    stubApi(() => [rec(35), rec(30), rec(25), rec(20, { rarity: 6 })]);
    const second = await fetchAndMergeGachaLog(
      db,
      "https://ef-webview.gryphline.com/?token=t&server_id=2",
      undefined,
      "test",
    );
    assert.equal(second.hasDataGap, false);
    const log2 = (await db.get<GachaLogData>("GACHA_LOG_test"))!;
    assert.equal(log2.info.charPityResetSeqId, "20", "marker carried over");
    assert.ok(log2.info.updatedAt! > log1.info.updatedAt!, "updatedAt strictly increases");
    const row2 = (await db.get<GachaLeaderboardEntry>(lbKey("test")))!;
    assert.deepEqual(row2.guilds, ["guild-1"], "guilds survive an update");
    assert.equal(row2.displayName, "Disp", "display fields survive a call that omits them");
    assert.equal(row2.accountIndex, 1);
    assert.equal(row2.logUpdatedAt, log2.info.updatedAt);

    // Same statistics as the old import would produce for a log without a marker
    // (carry-over only matters from the second import on).
    const stats = await getGachaStats(db, log2);
    assert.equal(stats.char.total, 6);
  } finally {
    db.close();
  }
}

async function testGuestAndRawKeys() {
  const db = new CustomDatabase(":memory:");
  await primeMetadata(db, POOL);
  try {
    stubApi(() => [rec(3), rec(2), rec(1)]);
    // Guest key: log is written, no leaderboard row.
    await fetchAndMergeGachaLog(db, "https://ef-webview.gryphline.com/?token=t&server_id=2", undefined, "EF_GUEST_42_abc");
    assert.ok(await db.get("GACHA_LOG_EF_GUEST_42_abc"));
    assert.equal(await db.get(lbKey("EF_GUEST_42_abc")), null);
    // A raw (prefix-less) uid key still works.
    await fetchAndMergeGachaLog(db, "https://ef-webview.gryphline.com/?token=t&server_id=2", undefined, "123456");
    assert.ok(await db.get("GACHA_LOG_123456"));
    assert.ok(await db.get(lbKey("123456")));
  } finally {
    db.close();
  }
}

async function testClear() {
  const db = new CustomDatabase(":memory:");
  await primeMetadata(db, POOL);
  try {
    const log: GachaLogData = {
      characterList: [rec(30), rec(20), rec(10)],
      weaponList: [],
      info: { uid: "test", lang: "en-us", export_timestamp: 0, charPityResetSeqId: "20" },
    };
    await db.set("GACHA_LOG_test", log);
    await db.set(lbKey("test"), { uid: "test", stats: {}, guilds: ["g"] });

    // Partial clear: only the newest record's timestamp range survives.
    const cutoff = String(1700000000000 + 25 * 1000);
    assert.equal(await clearGachaLog(db, "test", cutoff, undefined), true);
    const after = (await db.get<GachaLogData>("GACHA_LOG_test"))!;
    assert.deepEqual(after.characterList.map((r) => r.seqId), ["20", "10"]);
    assert.ok(after.info.updatedAt! > 0);
    const row = (await db.get<GachaLeaderboardEntry>(lbKey("test")))!;
    assert.equal(row.stats.TOTAL.total, 2, "leaderboard recomputed from the remaining records");
    assert.deepEqual(row.guilds, ["g"]);

    // Clearing everything removes the log and the row together.
    assert.equal(await clearGachaLog(db, "test"), true);
    assert.equal(await db.get("GACHA_LOG_test"), null);
    assert.equal(await db.get(lbKey("test")), null);
    assert.equal(await clearGachaLog(db, "test"), false);
  } finally {
    db.close();
  }
}

async function testMigrate() {
  const db = new CustomDatabase(":memory:");
  await primeMetadata(db, POOL);
  try {
    const src: GachaLogData = {
      characterList: [rec(8), rec(7)],
      weaponList: [],
      info: { uid: "EF_GUEST_1_a", lang: "en-us", export_timestamp: 9, nickname: "Guest" },
    };
    await db.set("GACHA_LOG_EF_GUEST_1_a", src);
    await db.set(lbKey("EF_GUEST_1_a"), { uid: "EF_GUEST_1_a", stats: {} });
    await db.set("GACHA_LOG_EF_55", {
      characterList: [rec(5)],
      weaponList: [],
      info: { uid: "EF_55", lang: "en-us", export_timestamp: 1 },
    });
    const merged = await migrateGachaLog(db, "EF_GUEST_1_a", "EF_55", "Disp", 2);
    assert.equal(merged!.characterList.length, 3);
    assert.ok(merged!.info.updatedAt! > 0);
    assert.equal(await db.get("GACHA_LOG_EF_GUEST_1_a"), null);
    assert.equal(await db.get(lbKey("EF_GUEST_1_a")), null);
    const row = (await db.get<GachaLeaderboardEntry>(lbKey("EF_55")))!;
    assert.equal(row.stats.TOTAL.total, 3);
    assert.equal(row.displayName, "Disp");
    assert.equal(await migrateGachaLog(db, "EF_missing", "EF_55"), null);
  } finally {
    db.close();
  }
}

async function testNoteGuild() {
  const db = new CustomDatabase(":memory:");
  try {
    assert.equal(noteLeaderboardGuild(db, "ghost", "g1"), false);
    assert.equal(await db.get(lbKey("ghost")), null, "never creates a row");

    await db.set(lbKey("u"), { uid: "u", stats: {} });
    const c = counts(db);
    assert.equal(noteLeaderboardGuild(db, "u", "g1"), true);
    assert.equal(c.sets.length, 1);
    assert.equal(noteLeaderboardGuild(db, "u", "g1"), false);
    assert.equal(noteLeaderboardGuild(db, "u", null), false);
    assert.equal(noteLeaderboardGuild(db, "u", undefined), false);
    assert.equal(c.sets.length, 1, "no write when the guild is already known");

    for (let i = 0; i < 60; i++) noteLeaderboardGuild(db, "u", `x${i}`);
    const row = (await db.get<GachaLeaderboardEntry>(lbKey("u")))!;
    assert.equal(row.guilds!.length, 50);
    assert.equal(row.guilds![49], "x59", "newest kept");
    assert.ok(!row.guilds!.includes("g1"), "oldest dropped");
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- Task 6 ----

async function testConcurrentLoad() {
  const file = path.join(os.tmpdir(), `g2-concurrent-${process.pid}-${Date.now()}.db`);
  const a = new CustomDatabase(file);
  const b = new CustomDatabase(file);
  try {
    await primeMetadata(a, POOL);
    // Cluster A starts a load; while its network call is in flight cluster B
    // finishes a load of different records for the same UID.
    stubApi(
      () => [rec(300), rec(200)],
      () => {
        commitFetchedGachaLog(b, "test", raw([rec(150), rec(100)]), {});
      },
    );
    await fetchAndMergeGachaLog(a, "https://ef-webview.gryphline.com/?token=t&server_id=2", undefined, "test");
    const log = (await b.get<GachaLogData>("GACHA_LOG_test"))!;
    assert.deepEqual(
      log.characterList.map((r) => r.seqId),
      ["300", "200", "150", "100"],
      "the record B wrote while A was fetching must survive A's merge",
    );
    const row = (await b.get<GachaLeaderboardEntry>(lbKey("test")))!;
    assert.equal(row.logUpdatedAt, log.info.updatedAt, "board follows the final log");
    assert.equal(row.stats.TOTAL.total, 4);
  } finally {
    a.close();
    b.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
}

async function testSharedRowsAreMerged() {
  const file = path.join(os.tmpdir(), `g2-shared-${process.pid}-${Date.now()}.db`);
  const a = new CustomDatabase(file);
  const b = new CustomDatabase(file);
  try {
    await primeMetadata(a, POOL, "other");
    commitFetchedGachaLog(a, "ua", raw([rec(1)]), {});
    commitFetchedGachaLog(b, "ub", raw([rec(2, { poolId: "other", poolName: "Other pool" })]), {});
    const sim = (await a.get<Record<string, any>>("SIM_POOL_RECORDS.GLOBAL"))!;
    assert.ok(sim[POOL] && sim["other"], "both users' pools are in the global dictionary");
    assert.ok(await a.get("SIM_POOL_RECORDS.ua"));
    assert.ok(await a.get("SIM_POOL_RECORDS.ub"));

    // GACHA_POOL_NAMES is merged, not replaced: two updates from two handles keep both names.
    const { updateLeaderboard } = await import("./gachaLeaderboard");
    await updateLeaderboard(a, "ua", (await a.get<GachaLogData>("GACHA_LOG_ua"))!);
    await updateLeaderboard(b, "ub", (await b.get<GachaLogData>("GACHA_LOG_ub"))!);
    const names = (await a.get<Record<string, string>>("GACHA_POOL_NAMES"))!;
    assert.equal(names[POOL], "Test pool");
    assert.equal(names["other"], "Other pool");

    // The pool-name row is written only when something is new.
    const c = counts(a);
    await updateLeaderboard(a, "ua", (await a.get<GachaLogData>("GACHA_LOG_ua"))!);
    assert.ok(!c.sets.includes("GACHA_POOL_NAMES"), "no rewrite of the shared row when unchanged");
  } finally {
    a.close();
    b.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
}

async function testStaleComputationNeverWins() {
  const db = new CustomDatabase(":memory:");
  await primeMetadata(db, POOL);
  try {
    const { updateLeaderboard } = await import("./gachaLeaderboard");
    const older: GachaLogData = {
      characterList: [rec(1)],
      weaponList: [],
      info: { uid: "test", lang: "en-us", export_timestamp: 0, updatedAt: 100 },
    };
    const newer: GachaLogData = {
      characterList: [rec(2), rec(1)],
      weaponList: [],
      info: { uid: "test", lang: "en-us", export_timestamp: 0, updatedAt: 200 },
    };
    await db.set("GACHA_LOG_test", newer);
    await updateLeaderboard(db, "test", newer);
    await updateLeaderboard(db, "test", older); // finishes later but is computed from older data
    const row = (await db.get<GachaLeaderboardEntry>(lbKey("test")))!;
    assert.equal(row.stats.TOTAL.total, 2);
    assert.equal(row.logUpdatedAt, 200);

    // A deleted log is never restored by an in-flight refresh.
    await db.delete("GACHA_LOG_test");
    await updateLeaderboard(db, "test", newer);
    assert.equal(await db.get(lbKey("test")), null);
  } finally {
    db.close();
  }
}

async function main() {
  const originalGet = axios.get;
  try {
    testPityMarkers();
    testNextUpdatedAt();
    await testImportWritesLeaderboardAndKeepsMarkers();
    await testGuestAndRawKeys();
    await testClear();
    await testMigrate();
    await testNoteGuild();
    await testConcurrentLoad();
    await testSharedRowsAreMerged();
    await testStaleComputationNeverWins();
    console.log("Gacha store write tests passed");
  } finally {
    axios.get = originalGet;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
