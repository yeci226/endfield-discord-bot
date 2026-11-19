/**
 * Stats-view benchmark: what one `/gacha view` costs before the stats cache
 * (parse the log row, compute, sync the leaderboard) and after it.
 *
 *   node -r ts-node/register scripts/bench-gacha-stats.ts            # cache path
 *   node -r ts-node/register scripts/bench-gacha-stats.ts --no-cache # the old path
 *   options: --runs N (default 20)  --pulls N (default 9000, ~2 MB of JSON)
 *
 * The synthetic log has its own seeded generator (scripts/render-gacha-fixture.ts
 * keeps its generator private and must not be edited); every pool has stored
 * metadata so nothing touches the network. A ~7 MB leaderboard blob is seeded
 * to mirror production, because the old view path rewrote it on every view.
 * The old path measured here is: db.get(log) + getGachaStats + updateLeaderboard
 * (which computes the stats a second time and re-reads the log inside its
 * transaction). Account-binding lookups are left out of both paths.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CustomDatabase } from "../src/utils/Database";
import {
  GachaLogData,
  GachaRecord,
  getGachaStats,
  updateLeaderboard,
} from "../src/utils/gachaLogUtils";
import { getCachedGachaStats } from "../src/features/gacha/gachaStatsCache";

const args = process.argv.slice(2);
const noCache = args.includes("--no-cache");
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const RUNS = num("--runs", 20);
const PULLS = num("--pulls", 9000);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UID = "EF_900001";
const LOG_KEY = `GACHA_LOG_${UID}`;

function buildLog(pulls: number): { log: GachaLogData; poolIds: string[] } {
  const rng = mulberry32(20261119);
  const perPool = 240;
  const poolCount = Math.ceil(pulls / perPool);
  const records: GachaRecord[] = [];
  const poolIds: string[] = [];
  const base = Date.UTC(2025, 0, 1);
  let seq = 0;
  for (let p = 0; p < poolCount; p++) {
    const poolId = `c_special_bench_${p}`;
    poolIds.push(poolId);
    let pity = 0;
    for (let i = 0; i < perPool && seq < pulls; i++, seq++) {
      pity++;
      const roll = rng();
      const rarity = pity >= 80 || roll < 0.02 ? 6 : roll < 0.12 ? 5 : 4;
      if (rarity === 6) pity = 0;
      const id = `chr_${String(Math.floor(rng() * 40)).padStart(4, "0")}`;
      records.push({
        seqId: String(100000 + seq),
        charId: id,
        charName: `Operator ${id.slice(-2)}`,
        rarity,
        gachaTs: String(base + seq * 41 * 60 * 1000),
        poolId,
        poolName: `特選尋訪「基準測試 ${p}」`,
        poolType: "E_CharacterGachaPoolType_Special",
        isFree: false,
      });
    }
  }
  records.sort((a, b) => Number(b.seqId) - Number(a.seqId));
  return {
    poolIds,
    log: {
      characterList: records,
      weaponList: [],
      info: {
        uid: UID,
        lang: "zh-tw",
        serverId: "2",
        nickname: "Bench",
        export_timestamp: base + seq * 41 * 60 * 1000,
      },
    },
  };
}

async function seedLeaderboard(db: CustomDatabase, targetBytes: number) {
  const entries: Record<string, any> = {};
  let bytes = 0;
  for (let i = 0; bytes < targetBytes; i++) {
    const stats: Record<string, any> = {};
    for (let g = 0; g < 14; g++) {
      stats[`c_special_g${g}`] = {
        total: 100 + g,
        sixStarCount: 2,
        fiveStarCount: 11,
        probability: 0.019,
      };
    }
    const entry = {
      uid: `EF_${1_000_000 + i}`,
      nickname: `Player ${i}`,
      displayName: `Display ${i}`,
      avatarUrl: `https://cdn.example.invalid/avatar/${i}.png`,
      lastUpdate: 1_760_000_000_000,
      total: 900,
      nonFreeTotal: 900,
      freeTotal: 0,
      poolNames: { a: "特選尋訪「甲」", b: "特選尋訪「乙」" },
      stats,
    };
    entries[entry.uid] = entry;
    bytes += JSON.stringify(entry).length;
  }
  await db.set("GACHA_LEADERBOARD_ENTRIES", entries);
  return bytes;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const changes = (db: CustomDatabase): number =>
  (db as any).db.prepare("SELECT total_changes() AS c").get().c;

async function main() {
  const file = path.join(
    os.tmpdir(),
    `bench-gacha-stats-${process.pid}-${Date.now()}.sqlite`,
  );
  const db = new CustomDatabase(file);
  try {
    const { log, poolIds } = buildLog(PULLS);
    for (const id of poolIds) {
      await db.set(`GACHA_POOL_METADATA_${id}`, {
        data: { up6_name: "Operator 01", all: [] },
        lastFetch: 0,
      });
    }
    await db.set(LOG_KEY, log);
    const logBytes = db.getRowToken(LOG_KEY)!.length;
    const blobBytes = await seedLeaderboard(db, 6_900_000);

    const oldView = async () => {
      const data = (await db.get<GachaLogData>(LOG_KEY))!;
      const stats = await getGachaStats(db, data);
      await updateLeaderboard(db, UID, data, "Viewer", 1, data.info.nickname);
      return stats;
    };
    const newView = async () => {
      const r = await getCachedGachaStats(db, LOG_KEY, (d) => getGachaStats(db, d));
      return r!.stats;
    };
    const view = noCache ? oldView : newView;

    // cold: first view of this log (cache path: a miss that also stores the entry)
    const cold: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await db.delete(`GACHA_STATS.${LOG_KEY}`);
      const t0 = process.hrtime.bigint();
      await view();
      cold.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }

    // repeat: the same view again (cache path: a hit)
    await view();
    const repeat: number[] = [];
    const writes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const c0 = changes(db);
      const t0 = process.hrtime.bigint();
      await view();
      repeat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      writes.push(changes(db) - c0);
    }

    const f = (n: number) => n.toFixed(2).padStart(9);
    console.log(
      JSON.stringify({
        mode: noCache ? "no-cache (old path)" : "cache",
        pulls: PULLS,
        logRowBytes: logBytes,
        leaderboardBlobBytes: blobBytes,
        statsCacheRowBytes: db.getRowToken(`GACHA_STATS.${LOG_KEY}`)?.length ?? null,
        runs: RUNS,
      }),
    );
    console.log(`first view (cold)    median ms ${f(median(cold))}`);
    console.log(`repeat view          median ms ${f(median(repeat))}`);
    console.log(`DB row writes per repeat view     ${median(writes)}`);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(file + suffix);
      } catch {}
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
