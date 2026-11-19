/**
 * Counts the API requests of "20 new pulls on a 9,000-pull log" for a full
 * fetch and for the incremental import, against a fake page source.
 *
 *   node -r ts-node/register scripts/bench-gacha-import.ts
 *
 * The real page size of the game API is not documented anywhere in this
 * repository, so the sizes are parameters (5 and 10 are printed).
 * "Full" assumes the API still serves the whole 9,000 pulls (worst case; the
 * real window is about 90 days, which makes a full fetch cheaper than this and
 * the incremental one unchanged).
 */
import axios from "axios";
import { CustomDatabase } from "../src/utils/Database";
import { fetchAndMergeGachaLog } from "../src/features/gacha/gachaStore";
import { GachaRecord } from "../src/features/gacha/gachaTypes";

const URL1 =
  "https://ef-webview.gryphline.com/page/gacha_char?token=t&server_id=2&lang=en-us";
const TYPES: Array<[string, number]> = [
  ["E_CharacterGachaPoolType_Standard", 3000],
  ["E_CharacterGachaPoolType_Special", 4000],
  ["E_CharacterGachaPoolType_Joint", 1000],
  ["E_CharacterGachaPoolType_Rerun", 500],
  ["E_CharacterGachaPoolType_Beginner", 40],
];
const WEAPON_POOLS: Array<[string, number]> = [
  ["w1", 200],
  ["w2", 150],
  ["w3", 110],
];

async function run(pageSize: number) {
  let seq = 1;
  const char: Record<string, GachaRecord[]> = {};
  const weapon: Record<string, GachaRecord[]> = {};
  const mk = (extra: Partial<GachaRecord>): GachaRecord => ({
    seqId: String(seq++),
    gachaTs: String(1700000000000 + seq * 1000),
    poolId: "p",
    poolName: "P",
    poolType: "",
    rarity: 4,
    isFree: false,
    kind: "draw",
    ...extra,
  });
  // interleave so seqIds are not grouped by pool
  const left: Array<[string, number, boolean]> = [
    ...TYPES.map(([t, n]) => [t, n, false] as [string, number, boolean]),
    ...WEAPON_POOLS.map(([t, n]) => [t, n, true] as [string, number, boolean]),
  ];
  for (const [t] of left) (left.find((l) => l[0] === t)![2] ? weapon : char)[t] = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const l of left) {
      if (l[1] <= 0) continue;
      remaining = true;
      l[1]--;
      (l[2] ? weapon : char)[l[0]].unshift(
        mk(l[2] ? { poolId: l[0], weaponId: "w" } : { poolType: l[0], charId: "c" }),
      );
    }
  }
  let requests = 0;
  axios.get = (async (url: string, config: any) => {
    const p = config?.params ?? {};
    if (url.includes("/api/content")) return { data: { code: 1 } };
    requests++;
    if (url.endsWith("/api/record/weapon/pool"))
      return {
        data: { code: 0, data: WEAPON_POOLS.map(([poolId]) => ({ poolId, poolName: poolId })) },
      };
    const list = url.endsWith("/api/record/char") ? char[p.pool_type] : weapon[p.pool_id];
    const rest = p.seq_id ? list.filter((r) => Number(r.seqId) < Number(p.seq_id)) : list;
    return {
      data: {
        code: 0,
        data: { list: rest.slice(0, pageSize).map((r) => ({ ...r })), hasMore: rest.length > pageSize },
      },
    };
  }) as typeof axios.get;

  const db = new CustomDatabase(":memory:");
  await fetchAndMergeGachaLog(db, URL1, undefined, "u");
  for (let i = 0; i < 15; i++)
    char[TYPES[1][0]].unshift(mk({ poolType: TYPES[1][0], charId: "c" }));
  for (let i = 0; i < 5; i++)
    char[TYPES[0][0]].unshift(mk({ poolType: TYPES[0][0], charId: "c" }));

  requests = 0;
  const t0 = Date.now();
  await fetchAndMergeGachaLog(db, URL1, undefined, "u");
  const incremental = { requests, ms: Date.now() - t0 };
  requests = 0;
  const t1 = Date.now();
  await fetchAndMergeGachaLog(db, URL1, undefined, "u", undefined, undefined, undefined, undefined, undefined, {
    forceFull: true,
  });
  const full = { requests, ms: Date.now() - t1 };
  db.close();
  console.log(`page size ${pageSize}: full ${full.requests} requests, incremental ${incremental.requests} requests`);
}

(async () => {
  for (const size of [5, 10]) await run(size);
})();
