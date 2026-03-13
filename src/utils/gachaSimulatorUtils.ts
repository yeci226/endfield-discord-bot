import { createCanvas } from "@napi-rs/canvas";
import { CustomDatabase } from "./Database";
import { fetchImage } from "./canvasUtils";
import { SkPoolItem } from "./skportApi";
import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface SimCharInfo {
  id: string;
  name: string;
  rarity: 4 | 5 | 6;
  iconUrl?: string;
  isUp?: boolean;
}

export interface SimPoolConfig {
  poolId: string;
  poolName: string;
  pityKey: string;
  isSpecial: boolean;
  sixStarUp?: SimCharInfo;
  fiveStarUpList: SimCharInfo[];
  sixStarPool: SimCharInfo[];
  fiveStarPool: SimCharInfo[];
  fourStarPool: SimCharInfo[];
}

export interface SimPityState {
  sixStarPity: number; // pulls since last 6★ (0 = just got one)
  fiveStarPity: number; // consecutive non-5★+ pulls
  isGuaranteed: boolean; // lost 50/50 last time → next 6★ is guaranteed UP
  pullsWithoutCurrentUp: number; // pulls since last current 6★ UP on special banner
}

export interface SimPullResult {
  rarity: 4 | 5 | 6;
  character: SimCharInfo;
  isUp: boolean;
  pitySixBefore: number; // Pity counter before this pull
}

interface SimPoolRecordChar {
  charId?: string;
  charName?: string;
}

interface SimPoolRecord {
  poolId: string;
  poolName: string;
  poolType?: string;
  lastSeenTs?: number;
  featuredSixStar?: SimPoolRecordChar;
  featuredFiveStars?: SimPoolRecordChar[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CDN = "https://endfieldtools.dev/assets/images/characters/";
export const FLOU_URL = `${CDN}flou.png`;
export const SILHOUETTE_URL = `${CDN}temp_silouette.png`;

const BASE_SIX_RATE = 0.008;
const BASE_FIVE_RATE = 0.08;
const SOFT_PITY_START = 65;
const SOFT_PITY_INC = 0.05;
const HARD_PITY = 80;
export const FIVE_STAR_PITY_CAP = 10;
export const SIX_STAR_PITY_CAP = HARD_PITY;
export const CURRENT_UP_HARD_PITY_CAP = 120;
const SIX_FIFTY_FIFTY = 0.5;
const CHAR_LIST_URL =
  "https://endfieldtools.dev/localdb/optimized/characters/characters-list.json";
const SIM_CHAR_LIST_CACHE_KEY = "SIM_CHAR_LIST_CACHE";
const SIM_CHAR_LIST_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const SIM_POOL_RECORDS_KEY_PREFIX = "SIM_POOL_RECORDS";

function normalizeRarity(raw: any): 4 | 5 | 6 | undefined {
  const n = Number(raw);
  if (n === 4 || n === 5 || n === 6) return n;
  return undefined;
}

function fromCharRecord(item: any): SimCharInfo | null {
  if (!item || !item.charId) return null;
  const rarity = normalizeRarity(item.rarity);
  if (!rarity) return null;
  return {
    id: item.charId,
    name: item.engName || item.charId,
    rarity,
    iconUrl: charIcon(item.charId),
  };
}

function ensureInPool(pool: SimCharInfo[], charInfo: SimCharInfo) {
  if (!pool.some((c) => c.id === charInfo.id)) {
    pool.push(charInfo);
  }
}

async function fetchLatestCharacterRoster(
  db: CustomDatabase,
): Promise<SimCharInfo[] | null> {
  const cache = await db.get<{ ts: number; items: SimCharInfo[] }>(
    SIM_CHAR_LIST_CACHE_KEY,
  );
  if (
    cache?.items?.length &&
    Date.now() - (cache.ts || 0) < SIM_CHAR_LIST_CACHE_TTL_MS
  ) {
    return cache.items;
  }

  try {
    const res = await axios.get(CHAR_LIST_URL, { timeout: 12000 });
    const raw = res.data;
    if (!raw || typeof raw !== "object") return cache?.items || null;

    const items = Object.values(raw)
      .map((it) => fromCharRecord(it))
      .filter((it): it is SimCharInfo => !!it);

    if (items.length > 0) {
      await db.set(SIM_CHAR_LIST_CACHE_KEY, {
        ts: Date.now(),
        items,
      });
      return items;
    }
  } catch {
    // Ignore network errors and fallback to cache/default pools.
  }

  return cache?.items || null;
}

export async function loadSimPoolRecords(
  db: CustomDatabase,
  userId: string,
): Promise<SimPoolRecord[]> {
  const key = `${SIM_POOL_RECORDS_KEY_PREFIX}.${userId}`;
  const records = await db.get<Record<string, SimPoolRecord>>(key);
  if (!records) return [];
  return Object.values(records).sort(
    (a, b) => Number(b.lastSeenTs || 0) - Number(a.lastSeenTs || 0),
  );
}

// ─── Default Pool Members ─────────────────────────────────────────────────────
function charIcon(id: string) {
  return `${CDN}icon_${id}.png`;
}

const DEFAULT_STANDARD_6: SimCharInfo[] = [
  {
    id: "chr_0009_azrila",
    name: "Azalea",
    rarity: 6,
    iconUrl: charIcon("chr_0009_azrila"),
  },
  {
    id: "chr_0015_lifeng",
    name: "Lifeng",
    rarity: 6,
    iconUrl: charIcon("chr_0015_lifeng"),
  },
  {
    id: "chr_0025_ardelia",
    name: "Ardelia",
    rarity: 6,
    iconUrl: charIcon("chr_0025_ardelia"),
  },
  {
    id: "chr_0026_lastrite",
    name: "Lastrite",
    rarity: 6,
    iconUrl: charIcon("chr_0026_lastrite"),
  },
  {
    id: "chr_0029_pograni",
    name: "Pograni",
    rarity: 6,
    iconUrl: charIcon("chr_0029_pograni"),
  },
];

const DEFAULT_5: SimCharInfo[] = [
  {
    id: "chr_0018_dapan",
    name: "Dapan",
    rarity: 5,
    iconUrl: charIcon("chr_0018_dapan"),
  },
  {
    id: "chr_0007_ling",
    name: "Ling",
    rarity: 5,
    iconUrl: charIcon("chr_0007_ling"),
  },
  {
    id: "chr_0024_gertrude",
    name: "Gertrude",
    rarity: 5,
    iconUrl: charIcon("chr_0024_gertrude"),
  },
  {
    id: "chr_0028_luoyi",
    name: "Luoyi",
    rarity: 5,
    iconUrl: charIcon("chr_0028_luoyi"),
  },
  {
    id: "chr_0030_mordo",
    name: "Mordo",
    rarity: 5,
    iconUrl: charIcon("chr_0030_mordo"),
  },
];

const DEFAULT_4: SimCharInfo[] = [
  {
    id: "chr_0019_karin",
    name: "Karin",
    rarity: 4,
    iconUrl: charIcon("chr_0019_karin"),
  },
  {
    id: "chr_0020_meurs",
    name: "Meurs",
    rarity: 4,
    iconUrl: charIcon("chr_0020_meurs"),
  },
  {
    id: "chr_0021_whiten",
    name: "Whiten",
    rarity: 4,
    iconUrl: charIcon("chr_0021_whiten"),
  },
  {
    id: "chr_0022_bounda",
    name: "Bounda",
    rarity: 4,
    iconUrl: charIcon("chr_0022_bounda"),
  },
  {
    id: "chr_0023_antal",
    name: "Antal",
    rarity: 4,
    iconUrl: charIcon("chr_0023_antal"),
  },
];

// ─── Pool Building ────────────────────────────────────────────────────────────
/**
 * Build a SimPoolConfig from an SkPoolItem returned by getCharacterPool().
 * Featured chars in skPool.chars are treated as:
 *   - index 0 → 6★ UP character (on special banners)
 *   - index 1+ → 5★ UP characters (if present)
 */
export function buildSimPoolFromSkPool(skPool: SkPoolItem): SimPoolConfig {
  const idLower = (skPool.id || "").toLowerCase();
  const hasFeaturedChars =
    Array.isArray(skPool.chars) && skPool.chars.length > 0;
  const isSpecial = idLower.includes("special") || hasFeaturedChars;
  const isBeginner = idLower.includes("beginner");
  const pityKey = isSpecial ? "special" : isBeginner ? "beginner" : "standard";

  // Parse featured chars from pool
  const featuredChars: SimCharInfo[] = (skPool.chars || []).map((c, i) => {
    const match = (c.pic || "").match(/icon_(chr_[\w]+)/);
    const id = match ? match[1] : `unknown_${i}`;
    return {
      id,
      name: c.name,
      rarity: 6,
      iconUrl: c.pic || undefined,
      isUp: true,
    };
  });

  let sixStarUp: SimCharInfo | undefined;
  const fiveStarUpList: SimCharInfo[] = [];

  if (isSpecial && featuredChars.length > 0) {
    sixStarUp = { ...featuredChars[0], rarity: 6 };
    for (let i = 1; i < featuredChars.length; i++) {
      fiveStarUpList.push({ ...featuredChars[i], rarity: 5 });
    }
  }

  // 6★ pool: standard 6★ roster + UP char (deduped)
  const sixStarPool: SimCharInfo[] = [...DEFAULT_STANDARD_6];
  if (sixStarUp && !sixStarPool.some((c) => c.id === sixStarUp!.id)) {
    sixStarPool.push({ ...sixStarUp });
  }

  // 5★ pool: defaults + UP chars (deduped)
  const fiveStarPool: SimCharInfo[] = [...DEFAULT_5];
  for (const c of fiveStarUpList) {
    if (!fiveStarPool.some((f) => f.id === c.id)) {
      fiveStarPool.push(c);
    }
  }

  return {
    poolId: skPool.id,
    poolName: skPool.name,
    pityKey,
    isSpecial,
    sixStarUp,
    fiveStarUpList,
    sixStarPool,
    fiveStarPool,
    fourStarPool: DEFAULT_4,
  };
}

export async function buildSimPoolFromSources(
  db: CustomDatabase,
  userId: string,
  skPool: Pick<SkPoolItem, "id" | "name" | "chars">,
): Promise<SimPoolConfig> {
  void userId;
  const cfg = buildSimPoolFromSkPool(skPool as SkPoolItem);

  const [latestRoster, poolRecords] = await Promise.all([
    fetchLatestCharacterRoster(db),
    loadSimPoolRecords(db, userId),
  ]);

  if (latestRoster && latestRoster.length > 0) {
    const six = latestRoster.filter((c) => c.rarity === 6);
    const five = latestRoster.filter((c) => c.rarity === 5);
    const four = latestRoster.filter((c) => c.rarity === 4);

    if (six.length > 0) cfg.sixStarPool = [...six];
    if (five.length > 0) cfg.fiveStarPool = [...five];
    if (four.length > 0) cfg.fourStarPool = [...four];
  }

  const rec = poolRecords.find((r) => r.poolId === cfg.poolId);
  if (rec) {
    if (!cfg.sixStarUp && rec.featuredSixStar?.charId) {
      const up = {
        id: rec.featuredSixStar.charId,
        name: rec.featuredSixStar.charName || rec.featuredSixStar.charId,
        rarity: 6 as const,
        iconUrl: charIcon(rec.featuredSixStar.charId),
        isUp: true,
      };
      cfg.sixStarUp = up;
      ensureInPool(cfg.sixStarPool, up);
      cfg.isSpecial = true;
    }

    if (cfg.fiveStarUpList.length === 0 && rec.featuredFiveStars?.length) {
      cfg.fiveStarUpList = rec.featuredFiveStars
        .filter((it) => !!it.charId)
        .slice(0, 2)
        .map((it) => ({
          id: it.charId!,
          name: it.charName || it.charId!,
          rarity: 5 as const,
          iconUrl: charIcon(it.charId!),
          isUp: true,
        }));

      for (const it of cfg.fiveStarUpList) {
        ensureInPool(cfg.fiveStarPool, it);
      }
    }
  }

  return cfg;
}

// ─── Pity State ───────────────────────────────────────────────────────────────
export async function loadPityState(
  db: CustomDatabase,
  userId: string,
  pityKey: string,
): Promise<SimPityState> {
  const saved = await db.get<SimPityState>(`simGacha.${userId}.${pityKey}`);
  return {
    sixStarPity: Math.max(0, saved?.sixStarPity ?? 0),
    fiveStarPity: Math.max(0, saved?.fiveStarPity ?? 0),
    isGuaranteed: !!saved?.isGuaranteed,
    pullsWithoutCurrentUp: Math.max(
      0,
      Math.min(CURRENT_UP_HARD_PITY_CAP - 1, saved?.pullsWithoutCurrentUp ?? 0),
    ),
  };
}

export async function savePityState(
  db: CustomDatabase,
  userId: string,
  pityKey: string,
  state: SimPityState,
): Promise<void> {
  await db.set(`simGacha.${userId}.${pityKey}`, state);
}

// ─── Core Pull Logic ──────────────────────────────────────────────────────────
function getSixStarRate(pity: number): number {
  if (pity >= HARD_PITY - 1) return 1;
  if (pity >= SOFT_PITY_START) {
    return Math.min(
      1,
      BASE_SIX_RATE + (pity - SOFT_PITY_START + 1) * SOFT_PITY_INC,
    );
  }
  return BASE_SIX_RATE;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Simulate `count` pulls, mutating `state` in place.
 * Returns array of pull results.
 */
export function simulatePulls(
  count: 1 | 10,
  state: SimPityState,
  pool: SimPoolConfig,
): SimPullResult[] {
  const results: SimPullResult[] = [];

  for (let i = 0; i < count; i++) {
    const pitySixBefore = state.sixStarPity;
    const supportsCurrentUpHardPity = pool.isSpecial && !!pool.sixStarUp;
    const forceCurrentUp =
      supportsCurrentUpHardPity &&
      state.pullsWithoutCurrentUp >= CURRENT_UP_HARD_PITY_CAP - 1;
    const roll = Math.random();
    const sixRate = getSixStarRate(state.sixStarPity);
    const isFiveGuarantee = state.fiveStarPity >= FIVE_STAR_PITY_CAP - 1;

    let rarity: 4 | 5 | 6;
    if (forceCurrentUp || roll < sixRate) {
      rarity = 6;
    } else if (isFiveGuarantee || roll < sixRate + BASE_FIVE_RATE) {
      rarity = 5;
    } else {
      rarity = 4;
    }

    let character: SimCharInfo;
    let isUp = false;
    let gotCurrentSixUp = false;

    if (rarity === 6) {
      state.sixStarPity = 0;
      state.fiveStarPity = 0;
      if (pool.isSpecial && pool.sixStarUp) {
        if (
          forceCurrentUp ||
          state.isGuaranteed ||
          Math.random() < SIX_FIFTY_FIFTY
        ) {
          character = pool.sixStarUp;
          isUp = true;
          gotCurrentSixUp = true;
          state.isGuaranteed = false;
        } else {
          const others = pool.sixStarPool.filter(
            (c) => c.id !== pool.sixStarUp!.id,
          );
          character =
            others.length > 0 ? pickRandom(others) : pool.sixStarPool[0];
          isUp = false;
          state.isGuaranteed = true;
        }
      } else {
        character = pickRandom(pool.sixStarPool);
      }
    } else if (rarity === 5) {
      state.sixStarPity++;
      state.fiveStarPity = 0;
      if (pool.fiveStarUpList.length > 0 && Math.random() < 0.5) {
        character = pickRandom(pool.fiveStarUpList);
        isUp = true;
      } else {
        character = pickRandom(pool.fiveStarPool);
      }
    } else {
      state.sixStarPity++;
      state.fiveStarPity++;
      character = pickRandom(pool.fourStarPool);
    }

    if (supportsCurrentUpHardPity) {
      if (gotCurrentSixUp) {
        state.pullsWithoutCurrentUp = 0;
      } else {
        state.pullsWithoutCurrentUp = Math.min(
          CURRENT_UP_HARD_PITY_CAP - 1,
          state.pullsWithoutCurrentUp + 1,
        );
      }
    } else {
      state.pullsWithoutCurrentUp = 0;
    }

    results.push({ rarity, character, isUp, pitySixBefore });
  }

  return results;
}

// ─── Canvas Rendering ─────────────────────────────────────────────────────────
const COL_W = 160;
const COL_H = 520;
const CHAR_H = 400;
const REFL_H = 120;
const STAR_URL =
  "https://endfieldtools.dev/assets/images/icons/icon_transparent_star.png";

/** Per-rarity visual palette matching rarity-violet (4★) / rarity-yellow (5★/6★) */
interface RarityStyle {
  columnBg: string;
  reflectionBg: string;
  blendColor: string;
  dotColor: string;
  dotStep: number;
  lightColor: string;
  interMid: string;
  glowColor: string;
  textGlow: string;
}

function getRarityStyle(rarity: 4 | 5 | 6): RarityStyle {
  if (rarity === 4) {
    // .column-container.rarity-violet
    return {
      columnBg: "#000000",
      reflectionBg: "#4A0077",
      blendColor: "#4A0077",
      dotColor: "#9B59B6",
      dotStep: 3,
      lightColor: "#9B59B6",
      interMid: "rgba(155,89,182,0.4)",
      glowColor: "#9B59B6",
      textGlow: "#9B59B6",
    };
  }
  if (rarity === 5) {
    // .column-container.rarity-yellow
    return {
      columnBg: "#F4D03F",
      reflectionBg: "#F4D03F",
      blendColor: "#F4D03F",
      dotColor: "#F7DC6F",
      dotStep: 4,
      lightColor: "#F7DC6F",
      interMid: "rgba(247,220,111,0.4)",
      glowColor: "#F7DC6F",
      textGlow: "#F7DC6F",
    };
  }
  // .column-container.rarity-orange (use for 6★)
  return {
    columnBg: "#D84315",
    reflectionBg: "#D84315",
    blendColor: "#D84315",
    dotColor: "#E64A19",
    dotStep: 4,
    lightColor: "#E64A19",
    interMid: "rgba(230,74,25,0.4)",
    glowColor: "#E64A19",
    textGlow: "#E64A19",
  };
}

/**
 * Draw a summon result image matching the EndfieldTools.DEV column layout.
 * 10-pull → 1600×520px  |  1-pull → 160×520px
 */
export async function drawSimulationImage(
  results: SimPullResult[],
): Promise<Buffer> {
  const count = results.length;
  const canvasW = COL_W * count;
  const canvas = createCanvas(canvasW, COL_H);
  const ctx = canvas.getContext("2d");

  // Load shared assets (static visible state from CSS)
  let flouImg: any = null;
  let silhouetteImg: any = null;
  let starImg: any = null;
  const [flouRes, silRes, starRes] = await Promise.allSettled([
    fetchImage(FLOU_URL, "sim_flou"),
    fetchImage(SILHOUETTE_URL, "sim_silouette"),
    fetchImage(STAR_URL, "sim_star"),
  ]);
  if (flouRes.status === "fulfilled") flouImg = flouRes.value;
  if (silRes.status === "fulfilled") silhouetteImg = silRes.value;
  if (starRes.status === "fulfilled") starImg = starRes.value;

  // Pre-load unique character images
  const charImages = new Map<string, any>();
  for (const r of results) {
    const url = r.character.iconUrl;
    if (url && !charImages.has(url)) {
      try {
        charImages.set(
          url,
          await fetchImage(url, `sim_char_${r.character.id}`),
        );
      } catch {
        /* fall back to silhouette */
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const result = results[i];
    const x = i * COL_W;
    const style = getRarityStyle(result.rarity);
    const isRainbow = result.rarity === 6;

    // .column-black-background
    ctx.fillStyle = "#000";
    ctx.fillRect(x, 0, COL_W, COL_H);

    // Column area: 400 + reflection 120
    const colX = x;
    const colY = 0;
    const refY = CHAR_H;

    // .column.show-background (base fill)
    ctx.fillStyle = style.columnBg;
    ctx.fillRect(colX, colY, COL_W, CHAR_H);

    // rarity yellow/orange has subtle radial pattern on background
    if (result.rarity >= 5) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      const step = style.dotStep;
      for (let py = 2; py < CHAR_H; py += step) {
        for (let px = 2; px < COL_W; px += step) {
          ctx.beginPath();
          ctx.arc(colX + px, colY + py, 0.75, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // .character-image (top:10%, width:100%, object-position:center top)
    const charImg = result.character.iconUrl
      ? charImages.get(result.character.iconUrl)
      : null;
    const imgToDraw = charImg || silhouetteImg;

    if (imgToDraw) {
      const drawW = COL_W;
      const drawH = (imgToDraw.height / imgToDraw.width) * drawW;
      const drawX = colX;
      const drawY = colY + CHAR_H * 0.1;

      ctx.save();
      ctx.beginPath();
      ctx.rect(colX, colY, COL_W, CHAR_H);
      ctx.clip();
      (ctx as any).filter = "blur(0.25px)";
      ctx.drawImage(imgToDraw, drawX, drawY, drawW, drawH);
      (ctx as any).filter = "none";
      ctx.restore();
    }

    // .character-blend-overlay (height:65%, gradient 0/45/100)
    const blendY = colY + CHAR_H - Math.floor(CHAR_H * 0.65);
    const blendGrad = ctx.createLinearGradient(0, colY + CHAR_H, 0, blendY);
    blendGrad.addColorStop(0.0, style.blendColor);
    blendGrad.addColorStop(0.45, style.blendColor);
    blendGrad.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = blendGrad;
    ctx.fillRect(colX, blendY, COL_W, CHAR_H - blendY);

    // .character-dot-pattern-overlay (height:50%, mask 45%)
    const dotY = colY + CHAR_H - Math.floor(CHAR_H * 0.5);
    for (let py = dotY; py < CHAR_H; py += style.dotStep) {
      const t = (py - dotY) / Math.max(1, CHAR_H - dotY);
      const alpha =
        t <= 0.55 ? 0.24 : Math.max(0, 0.24 * (1 - (t - 0.55) / 0.45));
      if (alpha <= 0) continue;
      const dotColor =
        style.dotColor === "#9B59B6"
          ? `rgba(155,89,182,${Math.min(0.24, alpha)})`
          : style.dotColor === "#F7DC6F"
            ? `rgba(247,220,111,${Math.min(0.24, alpha)})`
            : `rgba(230,74,25,${Math.min(0.24, alpha)})`;
      ctx.fillStyle = dotColor;
      for (let px = 0; px < COL_W; px += style.dotStep) {
        ctx.fillRect(colX + px, py, 1, 1);
      }
    }

    let silCanvas: any = null;
    let silW = 121;
    let silH = 201;
    let silX = colX + (COL_W - silW) / 2;
    let silY = colY + CHAR_H - silH + 30;

    if (silhouetteImg) {
      silCanvas = createCanvas(silW, silH);
      const silCtx = silCanvas.getContext("2d");
      silCtx.drawImage(silhouetteImg, 0, 0, silW, silH);
      silCtx.globalCompositeOperation = "source-atop" as any;
      silCtx.fillStyle = "rgba(0,0,0,1)";
      silCtx.fillRect(0, 0, silW, silH);
    }

    // Reflection: draw flou texture directly, then a subtle dark overlay,
    // and keep an upright silhouette layer above flou.
    if (flouImg) {
      const fw = 297;
      const fh = 153;
      const flouScale = Math.max(COL_W / fw, REFL_H / fh);
      const drawFW = fw * flouScale;
      const drawFH = fh * flouScale;
      const drawFX = colX + (COL_W - drawFW) / 2;
      const drawFY = refY + (REFL_H - drawFH) / 2;

      ctx.save();
      ctx.beginPath();
      ctx.rect(colX, refY, COL_W, REFL_H);
      ctx.clip();

      // flou.png as-is
      ctx.globalCompositeOperation = "source-over" as any;
      ctx.globalAlpha = 1;
      ctx.drawImage(flouImg, drawFX, drawFY, drawFW, drawFH);

      // high -> low darkening gradient across flou (top lighter, bottom darker)
      const flouDarkGrad = ctx.createLinearGradient(0, refY, 0, refY + REFL_H);
      flouDarkGrad.addColorStop(0, "rgba(0,0,0,0.48)");
      flouDarkGrad.addColorStop(1, "rgba(0,0,0,0.72)");
      ctx.fillStyle = flouDarkGrad;
      ctx.fillRect(colX, refY, COL_W, REFL_H);

      // Keep the bottom of the upright silhouette visible in reflection area.
      // We reuse the same silhouette placement, but clip to reflection only.
      if (silCanvas) {
        ctx.globalAlpha = 1;
        ctx.drawImage(silCanvas as any, silX, silY, silW, silH);
        ctx.globalAlpha = 1;
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // .fg-silhouette + .fg-silhouette-inner-glow (121x201, bottom:-30)
    if (silCanvas) {
      // Keep the main silhouette strictly inside the top column area.
      // Otherwise it bleeds into reflection (y >= CHAR_H) and causes a seam.
      ctx.save();
      ctx.beginPath();
      ctx.rect(colX, colY, COL_W, CHAR_H);
      ctx.clip();

      // inner glow layer
      ctx.save();
      ctx.globalAlpha = 0.68;
      (ctx as any).filter =
        `blur(2px) drop-shadow(0 0 18px ${style.glowColor}) drop-shadow(0 0 34px ${style.glowColor})`;
      ctx.drawImage(silCanvas as any, silX, silY, silW, silH);
      (ctx as any).filter = "none";
      ctx.restore();

      // black silhouette layer
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(silCanvas as any, silX, silY, silW, silH);
      ctx.restore();

      ctx.restore();
    }

    // .horizontal-light (bottom:15, width:128, height:2)
    const hlW = 128;
    const hlH = 2;
    const hlX = colX + (COL_W - hlW) / 2;
    const hlY = colY + CHAR_H - 15 - hlH;
    ctx.fillStyle = style.lightColor;
    ctx.fillRect(hlX, hlY, hlW, hlH);
    ctx.save();
    (ctx as any).shadowColor = style.lightColor;
    (ctx as any).shadowBlur = 7;
    ctx.fillRect(hlX, hlY, hlW, hlH);
    ctx.restore();

    // .stars-container + img.star
    const starCount = result.rarity;
    const starW = 20;
    const starH = 20;
    const starGap = 2;
    const starsRowW = starCount * starW + (starCount - 1) * starGap;
    const starsX = colX + (COL_W - starsRowW) / 2;
    const starsY = colY + CHAR_H - 30 - starH;
    for (let s = 0; s < starCount; s++) {
      const sx = starsX + s * (starW + starGap);
      if (starImg) {
        ctx.drawImage(starImg, sx, starsY, starW, starH);
      } else {
        ctx.font = "18px serif";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText("★", sx + 1, starsY + 17);
      }
    }

    // .text-and-line-group + .white-line-inner
    const groupBottom = 5;
    const lineW = 128;
    const lineX = colX + (COL_W - lineW) / 2;
    const lineY = colY + CHAR_H - groupBottom - 10;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lineX, lineY);
    ctx.lineTo(lineX + lineW, lineY);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.font = "700 8px NotoSansLatin, NotoSans, sans-serif";
    ctx.fillStyle = "#ffffff";
    (ctx as any).shadowColor = style.textGlow;
    (ctx as any).shadowBlur = 10;
    const line1 = (result.character.id || "UNKNOWN")
      .replace(/^chr_/, "")
      .replace(/_/g, " ")
      .toUpperCase()
      .slice(0, 16);
    const line2 = `PITY ${result.pitySixBefore}`;
    ctx.fillText(line1, colX + COL_W / 2, lineY - 3);
    ctx.fillText(line2, colX + COL_W / 2, lineY + 9);
    (ctx as any).shadowBlur = 0;

    // // .rainbow-overlay (orange only, visible for 6★)
    if (isRainbow) {
      ctx.save();
      ctx.globalCompositeOperation = "screen" as any;
      ctx.globalAlpha = 0.2;
      const rg = ctx.createLinearGradient(
        colX,
        colY,
        colX + COL_W,
        colY + CHAR_H,
      );
      rg.addColorStop(0, "rgba(255,0,0,0.4)");
      rg.addColorStop(0.1666, "rgba(255,165,0,0.4)");
      rg.addColorStop(0.3333, "rgba(255,255,0,0.4)");
      rg.addColorStop(0.5, "rgba(0,255,0,0.4)");
      rg.addColorStop(0.6666, "rgba(0,0,255,0.4)");
      rg.addColorStop(0.8333, "rgba(238,130,238,0.4)");
      rg.addColorStop(1, "rgba(255,0,0,0.4)");
      ctx.fillStyle = rg;
      (ctx as any).filter = "blur(3px)";
      ctx.fillRect(colX, colY, COL_W, CHAR_H);
      (ctx as any).filter = "none";
      ctx.restore();
    }

    // .inter-column-gradient-overlay (bottom 100px)
    const interH = 100;
    const interY = colY + CHAR_H - interH;
    const interG = ctx.createLinearGradient(0, colY + CHAR_H, 0, interY);
    interG.addColorStop(0, "rgba(255,255,255,0.5)");
    interG.addColorStop(0.2, "rgba(255,255,255,0.45)");
    interG.addColorStop(0.4, style.interMid);
    interG.addColorStop(0.6, "rgba(0,0,0,0)");
    ctx.fillStyle = interG;
    ctx.fillRect(colX, interY, COL_W, interH);

    // 4) mirrored silhouette reflection
    if (silhouetteImg) {
      const rw = 121;
      const rh = 201;
      const rx = colX + (COL_W - rw) / 2;
      const ry = refY + 20;

      const rsCanvas = createCanvas(rw, rh);
      const rsCtx = rsCanvas.getContext("2d");
      rsCtx.drawImage(silhouetteImg, 0, 0, rw, rh);
      rsCtx.globalCompositeOperation = "source-atop" as any;
      rsCtx.fillStyle = "rgba(0,0,0,1)";
      rsCtx.fillRect(0, 0, rw, rh);

      ctx.save();
      ctx.globalAlpha = 0.42;
      (ctx as any).filter = "brightness(0.8) blur(1px)";
      ctx.translate(rx + rw / 2, ry + rh);
      ctx.scale(1, -1);
      ctx.drawImage(rsCanvas, -rw / 2, 0, rw, rh);
      (ctx as any).filter = "none";

      // mask-image linear-gradient(0deg, black 0, black 20%, transparent)
      const rMask = ctx.createLinearGradient(0, refY, 0, refY + REFL_H);
      rMask.addColorStop(0, "rgba(0,0,0,0)");
      rMask.addColorStop(0.2, "rgba(0,0,0,0)");
      rMask.addColorStop(1, "rgba(0,0,0,0.60)");
      ctx.fillStyle = rMask;
      ctx.fillRect(colX, refY, COL_W, REFL_H);
      ctx.restore();
    }

    // .column-container:after right border width:4 with vertical mask
    const borderX = colX + COL_W - 4;
    const borderMask = ctx.createLinearGradient(0, 0, 0, COL_H);
    borderMask.addColorStop(0, "rgba(0,0,0,1)");
    borderMask.addColorStop(0.9, "rgba(0,0,0,1)");
    borderMask.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = borderMask;
    ctx.fillRect(borderX, 0, 4, COL_H);
  }

  return canvas.toBuffer("image/webp");
}
