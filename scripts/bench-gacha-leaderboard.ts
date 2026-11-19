/**
 * Leaderboard read benchmark: what one leaderboard view spends on loading the
 * board (read every GACHA_LB.* row, then remove duplicate EF / EF_CN aliases,
 * which parses both logs of every alias pair).
 *
 *   node -r ts-node/register scripts/bench-gacha-leaderboard.ts
 *   options: --entries N (default 1000)  --pairs N (alias pairs, default 10)
 *            --pulls N (pulls per alias log, default 9000)  --runs N (default 10)
 *
 * The loop is exactly what command/leaderboard.ts does, through the public
 * functions only, so the same script runs on the code before and after the
 * cache. "first view" = nothing cached; "repeat view" = the next views.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CustomDatabase } from "../src/utils/Database";
import {
  GachaLeaderboardEntry,
  GachaLogData,
  GachaRecord,
  deduplicateLeaderboardAliases,
  readLeaderboardEntries,
} from "../src/utils/gachaLogUtils";

const args = process.argv.slice(2);
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const ENTRIES = num("--entries", 1000);
const PAIRS = num("--pairs", 10);
const PULLS = num("--pulls", 9000);
const RUNS = num("--runs", 10);

function buildLog(uid: string, pulls: number): GachaLogData {
  const records: GachaRecord[] = [];
  for (let i = 0; i < pulls; i++) {
    records.push({
      seqId: String(100000 + i),
      charId: `chr_${String(i % 40).padStart(4, "0")}`,
      charName: `Operator ${i % 40}`,
      rarity: i % 50 === 0 ? 6 : i % 9 === 0 ? 5 : 4,
      gachaTs: String(1_735_000_000_000 + i * 60_000),
      poolId: `c_special_${Math.floor(i / 240)}`,
      poolName: `Pool ${Math.floor(i / 240)}`,
      poolType: "E_CharacterGachaPoolType_Special",
      isFree: false,
    });
  }
  records.sort((a, b) => Number(b.seqId) - Number(a.seqId));
  return {
    characterList: records,
    weaponList: [],
    info: { uid, lang: "en-us", serverId: "2", export_timestamp: 1 },
  };
}

function buildEntry(uid: string, i: number): GachaLeaderboardEntry {
  const stats: GachaLeaderboardEntry["stats"] = {
    TOTAL: { total: 900 + i, sixStarCount: 18, fiveStarCount: 90, probability: 0.02 },
  };
  for (let g = 0; g < 14; g++)
    stats[`c_special_g${g}`] = { total: 100 + g, sixStarCount: 2, fiveStarCount: 11, probability: 0.019 };
  return {
    uid,
    nickname: `Player ${i}`,
    displayName: `Display ${i}`,
    avatarUrl: `https://cdn.discordapp.com/avatars/${i}/abcdef.png`,
    lastUpdate: 1_760_000_000_000 + i,
    total: 900 + i,
    nonFreeTotal: 900 + i,
    freeTotal: 0,
    poolNames: { a: "Pool A", b: "Pool B" },
    guilds: ["1000000000000000001"],
    updatedAt: 1_760_000_000_000 + i,
    metricsVersion: 2,
    stats,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const file = path.join(os.tmpdir(), `bench-gacha-lb-${process.pid}-${Date.now()}.sqlite`);
  const db = new CustomDatabase(file);
  try {
    for (let i = 0; i < ENTRIES; i++) {
      const uid = `EF_${2_000_000 + i}`;
      await db.set(`GACHA_LB.${uid}`, buildEntry(uid, i));
    }
    for (let p = 0; p < PAIRS; p++) {
      const raw = String(3_000_000 + p);
      const gl = `EF_${raw}`;
      const cn = `EF_CN_${raw}`;
      await db.set(`GACHA_LOG_${gl}`, buildLog(gl, PULLS));
      await db.set(`GACHA_LOG_${cn}`, buildLog(cn, PULLS)); // identical history: one of the two goes
      await db.set(`GACHA_LB.${gl}`, buildEntry(gl, p));
      await db.set(`GACHA_LB.${cn}`, buildEntry(cn, p + 1));
    }
    const boardBytes = db
      .findKeysByPrefix("GACHA_LB.")
      .reduce((n, k) => n + (db.getRowToken(k)?.length ?? 0), 0);

    const view = async () => {
      const map: Record<string, GachaLeaderboardEntry> = {};
      for (const row of await readLeaderboardEntries(db)) map[row.uid] = row;
      return Object.keys(await deduplicateLeaderboardAliases(db, map)).length;
    };
    const timed = async () => {
      const t0 = process.hrtime.bigint();
      const n = await view();
      return { ms: Number(process.hrtime.bigint() - t0) / 1e6, n };
    };

    const first = await timed();
    const repeat: number[] = [];
    for (let i = 0; i < RUNS; i++) repeat.push((await timed()).ms);
    console.log(
      JSON.stringify({ entries: ENTRIES + PAIRS * 2, aliasPairs: PAIRS, pullsPerAliasLog: PULLS, boardBytes, shown: first.n }),
    );
    console.log(`first view   ms ${first.ms.toFixed(1)}`);
    console.log(`repeat view  median ms ${median(repeat).toFixed(1)} (of ${RUNS})`);
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
