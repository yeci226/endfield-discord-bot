import assert from "node:assert/strict";
import { CustomDatabase } from "../../utils/Database";
import {
  LB_BLOB_KEY,
  LB_MIGRATION_MARKER,
  deduplicateLeaderboardAliases,
  lbKey,
  migrateLeaderboardBlob,
  readLeaderboardEntries,
} from "./gachaLeaderboard";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord } from "./gachaTypes";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function entry(uid: string, total = 10): GachaLeaderboardEntry {
  return {
    uid,
    nickname: `nick-${uid}`,
    displayName: `disp-${uid}`,
    lastUpdate: 1700000000000,
    total,
    nonFreeTotal: total,
    freeTotal: 0,
    stats: {
      TOTAL: { total, sixStarCount: 1, fiveStarCount: 2, probability: 1 / total },
    },
  };
}

function emptyLog(uid: string): GachaLogData {
  return {
    characterList: [],
    weaponList: [],
    info: { uid, lang: "en-us", export_timestamp: 0 },
  };
}

function rawRow(db: CustomDatabase, key: string): string | undefined {
  return (
    (db as any).db.prepare("SELECT json FROM json WHERE ID = ?").get(key) as
      | { json: string }
      | undefined
  )?.json;
}

async function seedBlob(db: CustomDatabase, n: number) {
  const blob: Record<string, GachaLeaderboardEntry> = {};
  for (let i = 0; i < n; i++) {
    const uid = `EF_${1000 + i}`;
    blob[uid] = entry(uid, 10 + i);
    await db.set(`GACHA_LOG_${uid}`, emptyLog(uid));
  }
  await db.set(LB_BLOB_KEY, blob);
  return blob;
}

async function testMigration() {
  const db = new CustomDatabase(":memory:");
  const blob = await seedBlob(db, 1200);
  // Entries that must NOT be migrated.
  blob["EF_GUEST_1_abc"] = entry("EF_GUEST_1_abc");
  await db.set("GACHA_LOG_EF_GUEST_1_abc", emptyLog("EF_GUEST_1_abc"));
  blob["EF_undefined"] = entry("EF_undefined");
  await db.set("GACHA_LOG_EF_undefined", emptyLog("EF_undefined"));
  blob["EF_NOLOG"] = entry("EF_NOLOG"); // log was deleted
  // A row already written by the new code is never overwritten.
  const fresh = { ...entry("EF_1005", 999), guilds: ["g1"], updatedAt: 42 };
  await db.set(lbKey("EF_1005"), fresh);
  await db.set(LB_BLOB_KEY, blob);
  const blobBefore = rawRow(db, LB_BLOB_KEY);

  // The transaction size is bounded: no batch writes more than 500 rows.
  let maxPerTxn = 0;
  const realTxn = db.transaction.bind(db);
  (db as any).transaction = (cb: any) =>
    realTxn((store: any) => {
      let sets = 0;
      return cb({
        ...store,
        set: (k: string, v: unknown) => {
          sets++;
          maxPerTxn = Math.max(maxPerTxn, sets);
          store.set(k, v);
        },
      });
    });

  const first = await migrateLeaderboardBlob(db);
  assert.equal(first.status, "migrated");
  assert.equal(first.migrated, 1199, "1200 - the one that already existed");
  assert.ok(maxPerTxn <= 500, `batch of ${maxPerTxn} exceeds 500`);
  assert.ok(first.batches >= 3);

  assert.equal(rawRow(db, LB_BLOB_KEY), blobBefore, "blob must stay untouched");
  assert.deepEqual(await db.get(lbKey("EF_1005")), fresh, "existing row kept");
  assert.equal(await db.get(lbKey("EF_GUEST_1_abc")), null);
  assert.equal(await db.get(lbKey("EF_undefined")), null);
  assert.equal(await db.get(lbKey("EF_NOLOG")), null);
  const moved = (await db.get<GachaLeaderboardEntry>(lbKey("EF_1000")))!;
  assert.equal(moved.nickname, "nick-EF_1000");
  assert.deepEqual(moved.guilds, []);
  assert.equal(moved.updatedAt, 1700000000000);
  assert.equal(moved.metricsVersion, undefined, "legacy rows are recomputed later");
  assert.ok(await db.get(LB_MIGRATION_MARKER));

  // The marker row is not an entry, and readers see exactly the migrated rows.
  const entries = await readLeaderboardEntries(db);
  assert.equal(entries.length, 1200);
  assert.ok(entries.every((e) => typeof e.uid === "string"));

  // Second run: nothing happens, even if the blob changed.
  const rowsBefore = db.findKeysByPrefix("GACHA_LB.").length;
  await db.set(LB_BLOB_KEY, { ...blob, EF_NEW: entry("EF_NEW") });
  const second = await migrateLeaderboardBlob(db);
  assert.equal(second.status, "already-done");
  assert.equal(db.findKeysByPrefix("GACHA_LB.").length, rowsBefore);
  db.close();
}

async function testInterruptedResume() {
  const db = new CustomDatabase(":memory:");
  await seedBlob(db, 25);
  await assert.rejects(
    migrateLeaderboardBlob(db, {
      batchSize: 10,
      afterBatch: (i) => {
        if (i === 0) throw new Error("process died");
      },
    }),
    /process died/,
  );
  assert.equal(await db.get(LB_MIGRATION_MARKER), null, "no marker after a crash");
  const partial = db.findKeysByPrefix("GACHA_LB.").length;
  assert.equal(partial, 10, "the first batch committed, the second did not run");

  // A user imports while the migration is half-way: their new row must win.
  const newer = { ...entry("EF_1020", 7777), guilds: ["x"], metricsVersion: 2 };
  await db.set(lbKey("EF_1020"), newer);
  // ... and another user clears their log; the stale blob entry must not come back.
  await db.delete("GACHA_LOG_EF_1021");

  const resumed = await migrateLeaderboardBlob(db, { batchSize: 10 });
  assert.equal(resumed.status, "migrated");
  assert.deepEqual(await db.get(lbKey("EF_1020")), newer);
  assert.equal(await db.get(lbKey("EF_1021")), null, "cleared log is not resurrected");
  assert.equal(db.findKeysByPrefix("GACHA_LB.").length, 25 - 1);
  db.close();
}

async function testWriteDuringMigration() {
  const db = new CustomDatabase(":memory:");
  await seedBlob(db, 30);
  const newer = { ...entry("EF_1025", 5555), metricsVersion: 2 };
  await migrateLeaderboardBlob(db, {
    batchSize: 10,
    afterBatch: async (i) => {
      if (i === 0) await db.set(lbKey("EF_1025"), newer); // lands before its batch
      await tick();
    },
  });
  assert.deepEqual(await db.get(lbKey("EF_1025")), newer);
  db.close();
}

async function testEmptyAndConcurrentRuns() {
  const db = new CustomDatabase(":memory:");
  const r = await migrateLeaderboardBlob(db);
  assert.equal(r.status, "no-blob");
  assert.ok(await db.get(LB_MIGRATION_MARKER), "marker is set so it is not retried");
  assert.deepEqual(await readLeaderboardEntries(db), []);

  const db2 = new CustomDatabase(":memory:");
  await seedBlob(db2, 40);
  const [a, b] = await Promise.all([
    migrateLeaderboardBlob(db2, { batchSize: 7 }),
    migrateLeaderboardBlob(db2, { batchSize: 7 }),
  ]);
  assert.equal(a.migrated + b.migrated, 40, "two concurrent runs migrate each row once");
  assert.equal(db2.findKeysByPrefix("GACHA_LB.").length, 40);
  db.close();
  db2.close();
}

/** The prefix scan must not confuse EF_12 with EF_123 when checking for a log. */
async function testPrefixLookalikes() {
  const db = new CustomDatabase(":memory:");
  await db.set("GACHA_LOG_EF_123", emptyLog("EF_123"));
  await db.set(LB_BLOB_KEY, { EF_12: entry("EF_12"), EF_123: entry("EF_123") });
  await migrateLeaderboardBlob(db);
  assert.equal(await db.get(lbKey("EF_12")), null, "EF_12 has no log of its own");
  assert.ok(await db.get(lbKey("EF_123")));
  db.close();
}

// ---- deduplicateLeaderboardAliases keeps today's semantics ----

function rec(seq: number, poolId = "p1", rarity = 4): GachaRecord {
  return {
    seqId: String(seq),
    gachaTs: String(1700000000000 + seq),
    poolId,
    poolName: poolId,
    poolType: "E_CharacterGachaPoolType_Special",
    isFree: false,
    rarity,
    charId: "chr_x",
  };
}

function aliasLog(uid: string, seqs: number[], serverId = "2"): GachaLogData {
  return {
    characterList: seqs.map((s) => rec(s)),
    weaponList: [],
    info: { uid, lang: "en-us", serverId, export_timestamp: 0 },
  };
}

async function testAliasDedup() {
  const db = new CustomDatabase(":memory:");
  const entriesFor = (...uids: string[]) =>
    Object.fromEntries(uids.map((u) => [u, entry(u)]));

  // global log is a subset of the CN log -> the global row goes
  await db.set("GACHA_LOG_EF_7", aliasLog("EF_7", [1, 2]));
  await db.set("GACHA_LOG_EF_CN_7", aliasLog("EF_CN_7", [1, 2, 3]));
  let out = await deduplicateLeaderboardAliases(db, entriesFor("EF_7", "EF_CN_7"));
  assert.deepEqual(Object.keys(out), ["EF_CN_7"]);

  // CN log is the subset -> the CN row goes
  await db.set("GACHA_LOG_EF_8", aliasLog("EF_8", [1, 2, 3]));
  await db.set("GACHA_LOG_EF_CN_8", aliasLog("EF_CN_8", [2, 3]));
  out = await deduplicateLeaderboardAliases(db, entriesFor("EF_8", "EF_CN_8"));
  assert.deepEqual(Object.keys(out), ["EF_8"]);

  // identical logs -> the older row goes (tie keeps the fresher one)
  await db.set("GACHA_LOG_EF_9", aliasLog("EF_9", [1, 2]));
  await db.set("GACHA_LOG_EF_CN_9", aliasLog("EF_CN_9", [1, 2]));
  const e9 = entriesFor("EF_9", "EF_CN_9");
  e9.EF_9.lastUpdate = 10;
  e9.EF_CN_9.lastUpdate = 20;
  out = await deduplicateLeaderboardAliases(db, e9);
  assert.deepEqual(Object.keys(out), ["EF_CN_9"]);

  // neither is a subset -> two different people, both stay
  await db.set("GACHA_LOG_EF_10", aliasLog("EF_10", [1, 5]));
  await db.set("GACHA_LOG_EF_CN_10", aliasLog("EF_CN_10", [1, 6]));
  out = await deduplicateLeaderboardAliases(db, entriesFor("EF_10", "EF_CN_10"));
  assert.equal(Object.keys(out).length, 2);

  // different server -> both stay even though the records overlap
  await db.set("GACHA_LOG_EF_11", aliasLog("EF_11", [1, 2], "2"));
  await db.set("GACHA_LOG_EF_CN_11", aliasLog("EF_CN_11", [1, 2, 3], "1"));
  out = await deduplicateLeaderboardAliases(db, entriesFor("EF_11", "EF_CN_11"));
  assert.equal(Object.keys(out).length, 2);

  // only one alias on the board -> nothing to do, and the input is not mutated
  const single = entriesFor("EF_CN_12");
  out = await deduplicateLeaderboardAliases(db, single);
  assert.deepEqual(Object.keys(out), ["EF_CN_12"]);
  db.close();
}

async function main() {
  await testMigration();
  await testInterruptedResume();
  await testWriteDuringMigration();
  await testEmptyAndConcurrentRuns();
  await testPrefixLookalikes();
  await testAliasDedup();
  console.log("Gacha leaderboard storage tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
