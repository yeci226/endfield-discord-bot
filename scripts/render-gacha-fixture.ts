/**
 * Deterministic render fixture for the gacha cards.
 *
 * Builds a fake (seeded) gacha log, stubs every network image fetch with a
 * locally generated placeholder, renders a fixed set of cards and prints one
 * sha256 per decoded RGBA image as JSON on stdout.
 *
 *   node -r ts-node/register scripts/render-gacha-fixture.ts
 *
 * Everything that could make two runs differ (clock, Math.random, local
 * icon caches, network) is pinned here, never in product code.
 */
import crypto from "crypto";
import fs from "fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { CustomDatabase } from "../src/utils/Database";
import * as canvasUtils from "../src/utils/canvasUtils";
import {
  GachaLeaderboardEntry,
  GachaLogData,
  GachaRecord,
  getGachaStats,
} from "../src/utils/gachaLogUtils";
import { drawGachaStats, GachaType } from "../src/utils/gachaCanvasUtils";
import { drawGachaLeaderboard } from "../src/utils/gachaLeaderboardCanvasUtils";
import {
  drawSimulationImage,
  SimCharInfo,
  SimPullResult,
} from "../src/utils/gachaSimulatorUtils";
import { createTranslator } from "../src/utils/i18n";
import { renderedCardCache } from "../src/features/gacha/statsCanvas/cardCache";

// ---------------------------------------------------------------- seeded rng
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

// ----------------------------------------------------------------- fake data
const STANDARD_SIX = [
  ["chr_0009_azrila", "Azrila"],
  ["chr_0015_lifeng", "Lifeng"],
  ["chr_0025_ardelia", "Ardelia"],
  ["chr_0026_lastrite", "Last Rite"],
  ["chr_0029_pograni", "Pogranichnik"],
];
const FIVE_CHARS = [
  ["chr_0005_chen", "Chen"],
  ["chr_0007_ikut", "Ikut"],
  ["chr_0013_aglina", "Aglina"],
  ["chr_0014_aurora", "Aurora"],
  ["chr_0020_meurs", "Meurs"],
  ["chr_0021_whiten", "Whiten"],
];
const FOUR_CHARS = [
  ["chr_0004_pelica", "Pelica"],
  ["chr_0006_wolfgd", "Wolfgd"],
  ["chr_0012_avywen", "Avywen"],
  ["chr_0018_dapan", "Dapan"],
  ["chr_0019_karin", "Karin"],
];
const WEAPON_SIX = [
  ["wpn_sword_0005", "Sword Six A"],
  ["wpn_claym_0003", "Claymore Six B"],
  ["wpn_lance_0003", "Lance Six C"],
];
const WEAPON_FIVE = [
  ["wpn_pistol_0002", "Pistol Five"],
  ["wpn_funnel_0001", "Funnel Five"],
  ["wpn_sword_0007", "Sword Five"],
];
const WEAPON_FOUR = [
  ["wpn_pistol_0004", "Pistol Four"],
  ["wpn_lance_0006", "Lance Four"],
];

interface PoolSpec {
  id: string;
  name: string;
  type: string;
  pulls: number;
  upId?: string;
  upName?: string;
  free: number;
  weapon?: boolean;
}

const BASE_TS = Date.UTC(2026, 1, 1, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

const POOLS: PoolSpec[] = [
  {
    id: "c_standard_1",
    name: "常駐尋訪",
    type: "E_CharacterGachaPoolType_Standard",
    pulls: 130,
    free: 0,
  },
  {
    id: "c_special_0_9_1",
    name: "特選尋訪「晨曦」",
    type: "E_CharacterGachaPoolType_Special",
    pulls: 110,
    upId: "chr_0023_antal",
    upName: "Antal",
    free: 0,
  },
  {
    id: "c_special_1_0_1",
    name: "特選尋訪「熔爐」",
    type: "E_CharacterGachaPoolType_Special",
    pulls: 220,
    upId: "chr_0016_laevat",
    upName: "Laevatain",
    free: 10,
  },
  {
    id: "joint_1_0_1",
    name: "聯合尋訪「雙星」",
    type: "E_CharacterGachaPoolType_Joint",
    pulls: 120,
    upId: "chr_0017_yvonne",
    upName: "Yvonne",
    free: 0,
  },
  {
    id: "c_special_1_1_1",
    name: "特選尋訪「暗流」",
    type: "E_CharacterGachaPoolType_Special",
    pulls: 190,
    upId: "chr_0022_bounda",
    upName: "Bounda",
    free: 0,
  },
  {
    id: "weaponbox_1_0_1",
    name: "武庫申領「鋒刃」",
    type: "WeaponPool",
    pulls: 160,
    upId: "wpn_sword_0005",
    upName: "Sword Six A",
    free: 4,
    weapon: true,
  },
];

function buildRecords(spec: PoolSpec, startIdx: number, rng: () => number) {
  const out: GachaRecord[] = [];
  let pity = 0;
  let pityFive = 0;
  let guaranteed = false;
  const sixList = spec.weapon ? WEAPON_SIX : STANDARD_SIX;
  const fiveList = spec.weapon ? WEAPON_FIVE : FIVE_CHARS;
  const fourList = spec.weapon ? WEAPON_FOUR : FOUR_CHARS;
  const pick = (l: string[][]) => l[Math.floor(rng() * l.length)];
  for (let i = 0; i < spec.pulls; i++) {
    const seq = startIdx + i;
    const isFree = i < spec.free;
    let rarity = 4;
    const roll = rng();
    pity++;
    pityFive++;
    if (isFree) {
      rarity = i === 3 ? 6 : roll < 0.3 ? 5 : 4;
    } else if (pity >= 80 || roll < 0.018 + (pity > 60 ? 0.05 : 0)) {
      rarity = 6;
    } else if (pityFive >= 10 || roll < 0.11) {
      rarity = 5;
    }
    if (rarity >= 5) pityFive = 0;
    let item: string[];
    if (rarity === 6) {
      if (!isFree) pity = 0;
      if (spec.upId && (guaranteed || rng() < 0.5)) {
        item = [spec.upId, spec.upName || spec.upId];
        guaranteed = false;
      } else {
        item = pick(sixList);
        if (spec.upId) guaranteed = true;
      }
    } else if (rarity === 5) {
      item = pick(fiveList);
    } else {
      item = pick(fourList);
    }
    const rec: GachaRecord = {
      seqId: String(1000 + seq),
      rarity,
      gachaTs: String(BASE_TS + seq * 37 * 60 * 1000),
      poolId: spec.id,
      poolName: spec.name,
      poolType: spec.type,
      isFree,
    };
    if (spec.weapon) {
      rec.weaponId = item[0];
      rec.weaponName = item[1];
    } else {
      rec.charId = item[0];
      rec.charName = item[1];
    }
    out.push(rec);
  }
  return out;
}

function buildLog(): GachaLogData {
  const rng = mulberry32(20261119);
  let idx = 0;
  const chars: GachaRecord[] = [];
  const weapons: GachaRecord[] = [];
  for (const spec of POOLS) {
    const recs = buildRecords(spec, idx, rng);
    idx += spec.pulls;
    (spec.weapon ? weapons : chars).push(...recs);
  }
  // The stored log is newest first.
  chars.sort((a, b) => Number(b.seqId) - Number(a.seqId));
  weapons.sort((a, b) => Number(b.seqId) - Number(a.seqId));
  return {
    characterList: chars,
    weaponList: weapons,
    info: {
      uid: "EF_900001",
      lang: "zh-tw",
      serverId: "2",
      nickname: "Fixture",
      export_timestamp: BASE_TS + 400 * DAY,
    },
  };
}

async function seedPoolMetadata(db: CustomDatabase) {
  for (const spec of POOLS) {
    const all = spec.weapon
      ? [...WEAPON_SIX, ...WEAPON_FIVE, ...WEAPON_FOUR].map(([id, name], i) => ({
          id,
          name,
          rarity: i < WEAPON_SIX.length ? 6 : i < 6 ? 5 : 4,
        }))
      : [
          ...STANDARD_SIX.map(([id, name]) => ({ id, name, rarity: 6 })),
          ...(spec.upId ? [{ id: spec.upId, name: spec.upName, rarity: 6 }] : []),
          ...FIVE_CHARS.map(([id, name]) => ({ id, name, rarity: 5 })),
          ...FOUR_CHARS.map(([id, name]) => ({ id, name, rarity: 4 })),
        ];
    const data: any = { all };
    if (spec.upName) {
      data.up6_name = spec.upName;
      data.up6_item_name = spec.upName;
    }
    if (spec.upId) {
      data.up6_image = `https://stub.invalid/banner/${spec.id}.png`;
    }
    await db.set(`GACHA_POOL_METADATA_${spec.id}`, { data, lastFetch: 0 });
  }
}

function buildLeaderboardEntries(): GachaLeaderboardEntry[] {
  const rng = mulberry32(777);
  const entries: GachaLeaderboardEntry[] = [];
  for (let i = 0; i < 14; i++) {
    const total = 80 + Math.floor(rng() * 900);
    const six = Math.floor(total * (0.008 + rng() * 0.02));
    const five = Math.floor(total * (0.07 + rng() * 0.05));
    const stat = {
      total,
      sixStarCount: six,
      fiveStarCount: five,
      probability: six / total,
    };
    entries.push({
      uid: `EF_90${String(i).padStart(4, "0")}`,
      nickname: `Player${i}`,
      displayName: `Display ${i}`,
      avatarUrl: `https://stub.invalid/avatar/${i}.png`,
      lastUpdate: BASE_TS + i * DAY,
      total,
      nonFreeTotal: total,
      freeTotal: 0,
      stats: {
        TOTAL: stat,
        SpecialShared: { ...stat, total: Math.floor(total / 2) },
      },
    });
  }
  return entries;
}

function buildSimResults(): SimPullResult[] {
  const chars: SimCharInfo[] = [
    { id: "chr_0016_laevat", name: "Laevatain", rarity: 6, isUp: true },
    { id: "chr_0005_chen", name: "Chen", rarity: 5 },
    { id: "chr_0004_pelica", name: "Pelica", rarity: 4 },
    { id: "chr_0006_wolfgd", name: "Wolfgd", rarity: 4 },
    { id: "chr_0007_ikut", name: "Ikut", rarity: 5 },
    { id: "chr_0012_avywen", name: "Avywen", rarity: 4 },
    { id: "chr_0018_dapan", name: "Dapan", rarity: 4 },
    { id: "chr_0009_azrila", name: "Azrila", rarity: 6 },
    { id: "chr_0019_karin", name: "Karin", rarity: 4 },
    { id: "chr_0013_aglina", name: "Aglina", rarity: 5 },
  ].map((c) => ({
    ...c,
    rarity: c.rarity as 4 | 5 | 6,
    iconUrl: `https://stub.invalid/char/${c.id}.png`,
  }));
  return chars.map((character, i) => ({
    rarity: character.rarity,
    character,
    isUp: !!character.isUp,
    pitySixBefore: i * 7,
  }));
}

// -------------------------------------------------------------------- stubs
function placeholderFor(url: string) {
  const h = crypto.createHash("md5").update(url).digest();
  const c = createCanvas(256, 256);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0, `rgb(${h[0]},${h[1]},${h[2]})`);
  g.addColorStop(1, `rgb(${h[3]},${h[4]},${h[5]})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = `rgb(${h[6]},${h[7]},${h[8]})`;
  ctx.fillRect(64, 64, 128, 128);
  return c.toBuffer("image/png");
}

const placeholderCache = new Map<string, any>();
let stubsInstalled = false;

function installStubs() {
  if (stubsInstalled) return;
  stubsInstalled = true;

  // Every network image fetch -> a placeholder derived from the URL.
  (canvasUtils as any).fetchImage = async (url: string) => {
    let img = placeholderCache.get(url);
    if (!img) {
      img = await loadImage(placeholderFor(url));
      placeholderCache.set(url, img);
    }
    return img;
  };

  // Pool content API used by drawGachaStats.
  (globalThis as any).fetch = async (url: string) => {
    const m = /pool_id=([^&]+)/.exec(String(url));
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: { pool: { up6_image: `https://stub.invalid/banner/${m?.[1]}.png` } },
      }),
    };
  };

  // Local icon caches are git-ignored and differ per machine: pretend they are empty.
  const realExists = fs.existsSync;
  (fs as any).existsSync = (p: any) => {
    const s = String(p).replace(/\\/g, "/");
    if (/\/assets\/(remote_cache|cache)(\/|$)/.test(s)) return false;
    return realExists(p);
  };
  // The icon loader indexes those directories with readdirSync instead of probing.
  const realReaddir = fs.readdirSync;
  (fs as any).readdirSync = (p: any, ...rest: any[]) => {
    const s = String(p).replace(/\\/g, "/");
    if (/\/assets\/(remote_cache|cache)\/?$/.test(s)) return [];
    return (realReaddir as any)(p, ...rest);
  };

  // Any leftover randomness (avatar fallback picks a random profile image).
  Math.random = mulberry32(1);
}

// ------------------------------------------------------------------- render
async function rgbaHash(buf: Buffer): Promise<string> {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const hash = crypto.createHash("sha256");
  hash.update(`${img.width}x${img.height}:`);
  hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return hash.digest("hex");
}

export async function renderGachaFixture(
  dumpDir?: string,
): Promise<Record<string, string>> {
  installStubs();
  // RENDER_FIXTURE_NO_CARD_CACHE=1 reproduces the pre-cache path.
  if (process.env.RENDER_FIXTURE_NO_CARD_CACHE === "1") {
    renderedCardCache.enabled = false;
  }
  const db = new CustomDatabase(":memory:");
  await seedPoolMetadata(db);
  const data = buildLog();
  const stats = await getGachaStats(db, data);
  const tr = createTranslator("tw");
  const trEn = createTranslator("en");
  const out: Record<string, string> = {};
  const record = async (name: string, buf: Buffer) => {
    out[name] = await rgbaHash(buf);
    if (dumpDir) {
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(`${dumpDir}/${name}.webp`, buf);
    }
  };

  const stat = async (
    name: string,
    type: GachaType,
    poolId?: string,
    page = 0,
    t: any = tr,
  ) => {
    const buf = await drawGachaStats(data, stats, t, type, poolId, page, db);
    await record(name, buf);
    if (renderedCardCache.enabled) {
      // The card cache must hand back the very same buffer for the same inputs.
      const again = await drawGachaStats(data, stats, t, type, poolId, page, db);
      if (again !== buf) throw new Error(`card cache miss for ${name}`);
    }
  };

  await stat("overview_limited", "limited_char");
  await stat("overview_limited_page2", "limited_char", undefined, 1);
  await stat("overview_weapon", "weapon");
  await stat("overview_standard", "standard_char");
  await stat("detail_special_page1", "limited_char", "c_special_1_0_1", 0);
  await stat("detail_special_page2", "limited_char", "c_special_1_0_1", 1);
  await stat("detail_special_last_page", "limited_char", "c_special_1_0_1", 5);
  await stat("detail_joint", "limited_char", "joint_1_0_1", 0);
  await stat("detail_weapon", "weapon", "weaponbox_1_0_1", 0);
  await stat("detail_standard", "standard_char", "c_standard_1", 0);
  await stat("overview_limited_en", "limited_char", undefined, 0, trEn);

  const entries = buildLeaderboardEntries();
  const lbPulls = await drawGachaLeaderboard(
    entries,
    [entries[12].uid],
    "TOTAL",
    "pulls",
    tr,
    {},
  );
  await record("leaderboard_total_pulls", lbPulls);
  const lbLuck = await drawGachaLeaderboard(
    entries,
    [entries[2].uid],
    "SpecialShared",
    "luck",
    tr,
    { SpecialShared: "特選尋訪" },
  );
  await record("leaderboard_special_luck", lbLuck);

  await record("simulator_10_pull", await drawSimulationImage(buildSimResults()));
  await record(
    "simulator_1_pull",
    await drawSimulationImage(buildSimResults().slice(0, 1)),
  );

  return out;
}

if (require.main === module) {
  renderGachaFixture(process.env.RENDER_FIXTURE_DUMP)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
