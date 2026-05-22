import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import * as path from "path";
import * as fs from "fs";
import axios from "axios";

const ASSETS_DIR = path.join(__dirname, "../assets");

// ── Font Registration ──────────────────────────────────────────────────────────
const fontDir = path.join(__dirname, "../assets/fonts");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-TC-400.woff2"), "NotoSansTC");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-TC-700.woff2"), "NotoSansTCBold");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-TC-500.woff2"), "NotoSansTCMed");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-500.woff2"),    "NotoSansLatin");
// Fallback for rare CJK characters not covered by Noto Sans TC subsets
GlobalFonts.registerFromPath(path.join(fontDir, "NotoSansCJKtc-Regular.otf"), "NotoSansCJKFallback");

// ── Image cache ────────────────────────────────────────────────────────────────
const IMG_CACHE = new Map<string, Buffer>();
async function fetchBuf(url: string): Promise<Buffer | null> {
  if (IMG_CACHE.has(url)) return IMG_CACHE.get(url)!;
  try {
    const r = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 8000 });
    const buf = Buffer.from(r.data);
    if (IMG_CACHE.size > 400) IMG_CACHE.delete(IMG_CACHE.keys().next().value!);
    IMG_CACHE.set(url, buf);
    return buf;
  } catch { return null; }
}

// ── Types ──────────────────────────────────────────────────────────────────────
export interface IndieHardChar {
  charId: string; level: number; potentialLevel: number;
  avatarUrl: string; evolvePhase: number;
  rarity: { key: string; value: string };
  property: { key: string; value: string };
}
export interface IndieHardEnemy {
  id: string; name: string; desc: string; level: number;
  imageUrl: string; ability: string;
}
export interface IndieHardDungeon {
  id: string; name: string; isPass: boolean;
  bestRecord: { chars: IndieHardChar[]; ts: string; passTs: string } | null;
  desc: string; feature: string; enemies: IndieHardEnemy[]; recommendLevel: number;
}
export interface IndieHardGroup {
  id: string; name: string; pic: string;
  dungeonGroups: { normalDungeon: IndieHardDungeon; hardDungeon: IndieHardDungeon }[];
  activityStartTs: string; activityEndTs: string; activityName: string;
  achieve: {
    achievementData: { id: string; name: string; initIcon: string; platedIcon: string; cateName: string; initLevel: number };
    level: number; isPlated: boolean; obtainTs: string;
  };
  isInActivity: boolean;
}

// ── Palette ────────────────────────────────────────────────────────────────────
const C = {
  bg:      "#0c0e14",
  bg2:     "#131620",
  bg3:     "#181b26",
  border:  "rgba(255,255,255,0.07)",
  border2: "rgba(255,255,255,0.13)",
  fg:      "#dde1ee",
  fg2:     "#9aa0b8",
  muted:   "#555e78",
  accent:  "#e84040",
  gold:    "#d4a030",
  pass:    "#3db36a",
  r6:      "#d4802a",
  r5:      "#9060cc",
  r4:      "#4070d8",
};
const RARITY_COL: Record<string, string> = {
  rarity_6: C.r6, rarity_5: C.r5, rarity_4: C.r4,
  rarity_3: "#33c2ff", rarity_2: "#b4d945", rarity_1: "#888888",
};
function rarityCol(key: string) { return RARITY_COL[key] ?? "#888888"; }

// ── Canvas helpers ─────────────────────────────────────────────────────────────
function rr(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  const R = Math.min(r, Math.abs(w / 2), Math.abs(h / 2));
  ctx.beginPath();
  ctx.moveTo(x + R, y);
  ctx.lineTo(x + w - R, y); ctx.quadraticCurveTo(x + w, y, x + w, y + R);
  ctx.lineTo(x + w, y + h - R); ctx.quadraticCurveTo(x + w, y + h, x + w - R, y + h);
  ctx.lineTo(x + R, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - R);
  ctx.lineTo(x, y + R); ctx.quadraticCurveTo(x, y, x + R, y);
  ctx.closePath();
}
function rrFill(ctx: any, x: number, y: number, w: number, h: number, r: number, color: string) {
  ctx.fillStyle = color; rr(ctx, x, y, w, h, r); ctx.fill();
}
function rrStroke(ctx: any, x: number, y: number, w: number, h: number, r: number, color: string, lw = 1) {
  ctx.strokeStyle = color; ctx.lineWidth = lw; rr(ctx, x, y, w, h, r); ctx.stroke();
}
function drawImageCover(ctx: any, img: any, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s, ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}
function fmtTime(sec: number) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function fmtDate(ts: string) {
  const d = new Date(parseInt(ts, 10) * 1000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
function parseFeatures(feat: string): { text: string; warn: boolean }[] {
  return feat.trim().split("\n")
    .map(l => l.replace(/<[^>]+>/g, "").replace(/^\s*[-\u2013\u00b7\u2022]\s*/, "").trim())
    .filter(Boolean)
    .map(text => ({ text, warn: /禁止|清退|封印/.test(text) }));
}
function hexAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Load a local asset image (from assets dir). Returns null if not found. */
async function loadLocalAsset(relPath: string): Promise<any | null> {
  const fullPath = path.join(ASSETS_DIR, relPath);
  if (!fs.existsSync(fullPath)) return null;
  try { return await loadImage(fs.readFileSync(fullPath)); } catch { return null; }
}


function wrapText(ctx: any, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Layout constants ───────────────────────────────────────────────────────────
const W        = 1920;
const SIDEBAR_W = 280;
const BODY_W   = W - SIDEBAR_W;
const HALF_W   = Math.floor(BODY_W / 2);  // 820px per dungeon half

const TOP_MARGIN = 20;   // margin above first pair
const PAIR_H    = 340;   // fixed height per pair (canvas scales vertically)
const PAIR_GAP  = 18;    // gap between pairs (visual separator)
const TITLE_H   = 50;    // merged title row
const ENEMY_H   = 120;   // enemy strip per half (icon 64 + 2-line name)
// Content per half after title and enemy strip:
// CONTENT_H = PAIR_H - TITLE_H - 1 - ENEMY_H - 1 = 198

function getCanvasH(n: number) { return TOP_MARGIN + n * PAIR_H + (n - 1) * PAIR_GAP + TOP_MARGIN; }

// ── Main export ────────────────────────────────────────────────────────────────
export async function buildIndieHardCard(group: IndieHardGroup): Promise<Buffer> {
  const n = group.dungeonGroups.length;
  const H = getCanvasH(n);

  // Pre-fetch
  const obtainTs   = parseInt(group.achieve.obtainTs, 10);
  const achObtained = obtainTs > 0;
  const achIconUrl = achObtained && group.achieve.achievementData.platedIcon
    ? group.achieve.achievementData.platedIcon
    : group.achieve.achievementData.initIcon; // always fetch (needed for placeholder too)

  const picBuf = await fetchBuf(group.pic);
  const achBuf = await fetchBuf(achIconUrl);

  const enemyUrls = new Map<string, string>();
  const charUrls  = new Map<string, string>();
  for (const dg of group.dungeonGroups) {
    for (const d of [dg.normalDungeon, dg.hardDungeon]) {
      for (const e of d.enemies) enemyUrls.set(e.id, e.imageUrl);
      if (d.bestRecord) for (const c of d.bestRecord.chars) charUrls.set(c.charId, c.avatarUrl);
    }
  }

  const allSettled = await Promise.allSettled([
    ...Array.from(enemyUrls.entries()).map(([id, url]) => fetchBuf(url).then(b => ({ id, b, t: "e" }))),
    ...Array.from(charUrls.entries()).map(([id, url]) => fetchBuf(url).then(b => ({ id, b, t: "c" }))),
  ]);
  const eImgs = new Map<string, any>();
  const cImgs = new Map<string, any>();
  for (const r of allSettled) {
    if (r.status !== "fulfilled" || !r.value?.b) continue;
    try {
      const img = await loadImage(r.value.b);
      if (r.value.t === "e") eImgs.set(r.value.id, img);
      else cImgs.set(r.value.id, img);
    } catch {}
  }
  let picImg: any = null, achImg: any = null;
  if (picBuf) try { picImg = await loadImage(picBuf); } catch {}
  if (achBuf) try { achImg = await loadImage(achBuf); } catch {}

  // Load phase / rank / property element assets
  const phaseImgs = new Map<number, any>();
  const rankImgs  = new Map<number, any>();
  const propImgs  = new Map<string, any>();
  // Phase 0–4
  for (let p = 0; p <= 4; p++) {
    try {
      const buf = fs.readFileSync(path.join(ASSETS_DIR, `phase/${p}.png`));
      phaseImgs.set(p, await loadImage(buf));
    } catch {}
  }
  // Rank 0–5
  for (let r = 0; r <= 5; r++) {
    try {
      const buf = fs.readFileSync(path.join(ASSETS_DIR, `rank/${r}.png`));
      rankImgs.set(r, await loadImage(buf));
    } catch {}
  }
  // Property/element keys seen in this group
  const propKeys = new Set<string>();
  for (const dg of group.dungeonGroups) {
    for (const d of [dg.normalDungeon, dg.hardDungeon]) {
      if (d.bestRecord) for (const c of d.bestRecord.chars) {
        propKeys.add(c.property.key.replace("char_property_", ""));
      }
    }
  }
  for (const pk of propKeys) {
    for (const ext of ["jpg", "png", "webp"]) {
      const p = path.join(ASSETS_DIR, `element/${pk}.${ext}`);
      if (fs.existsSync(p)) {
        try { propImgs.set(pk, await loadImage(fs.readFileSync(p))); } catch {}
        break;
      }
    }
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as any;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  drawSidebar(ctx, group, picImg, achImg, achObtained, H);

  for (let i = 0; i < n; i++) {
    const py = TOP_MARGIN + i * (PAIR_H + PAIR_GAP);
    drawPairRow(ctx, group.dungeonGroups[i], SIDEBAR_W, py, eImgs, cImgs, phaseImgs, rankImgs, propImgs);
  }

  return canvas.toBuffer("image/png");
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR  (vertically centred content)
// ─────────────────────────────────────────────────────────────────────────────
function drawSidebar(
  ctx: any, group: IndieHardGroup,
  picImg: any, achImg: any, achObtained: boolean, H: number,
) {
  ctx.fillStyle = C.bg2;
  ctx.fillRect(0, 0, SIDEBAR_W, H);

  const P = 20;
  const ART_H = 200;
  const GAP = 22;
  const NAME_H = 14 + 8 + 32; // sub-label + gap + name
  const BADGE_H = 72; // always show badge block
  const PROG_H = 52;

  const blockH = ART_H + GAP + NAME_H + GAP + BADGE_H + GAP + PROG_H;
  const startY = Math.max(0, Math.floor((H - blockH) / 2));

  // ── Art panel ──
  const artY = startY;
  ctx.fillStyle = C.bg3;
  ctx.fillRect(0, artY, SIDEBAR_W, ART_H);
  if (picImg) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, artY, SIDEBAR_W, ART_H); ctx.clip();
    ctx.filter = "brightness(55%) saturate(65%)";
    drawImageCover(ctx, picImg, 0, artY, SIDEBAR_W, ART_H);
    ctx.filter = "none";
    const grad = ctx.createLinearGradient(0, artY + ART_H * 0.5, 0, artY + ART_H);
    grad.addColorStop(0, "transparent");
    grad.addColorStop(1, C.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, artY, SIDEBAR_W, ART_H);
    ctx.restore();
  }

  // Right border — drawn after art so it's on top
  ctx.fillStyle = C.border2;
  ctx.fillRect(SIDEBAR_W - 1, 0, 1, H);

  // ── Name block ──
  let iy = artY + ART_H + GAP;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = C.accent;
  ctx.font = `500 12px NotoSansLatin`;
  ctx.fillText("INDIE HARD", P, iy);
  iy += 14 + 8;
  ctx.fillStyle = C.fg;
  ctx.font = `bold 26px NotoSansTCBold, NotoSansCJKFallback`;
  ctx.fillText(group.activityName, P, iy);
  iy += 32 + GAP;

  // ── Badge block (always shown) ──
  {
    const BIMGSZ = 46;
    const bimx = P;
    const bimy = iy + (BADGE_H - BIMGSZ) / 2;

    // Icon — obtained = colour, not-obtained = greyscale overlay
    ctx.save(); rr(ctx, bimx, bimy, BIMGSZ, BIMGSZ, 6); ctx.clip();
    if (achImg) {
      if (!achObtained) ctx.globalAlpha = 0.25;
      drawImageCover(ctx, achImg, bimx, bimy, BIMGSZ, BIMGSZ);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(bimx, bimy, BIMGSZ, BIMGSZ);
    }
    ctx.restore();

    const btx = bimx + BIMGSZ + 10;
    const lblH = 13 + 6 + 16;
    const lblY = iy + (BADGE_H - lblH) / 2;

    // sub-label
    ctx.textBaseline = "top";
    if (achObtained) {
      // "蝕刻章已獲得" in gold
      ctx.fillStyle = C.gold;
      ctx.font = `500 13px NotoSansTCMed, NotoSansCJKFallback`;
      ctx.fillText("Seal Obtained", btx, lblY);
    } else {
      // "蝕刻章" in muted
      ctx.fillStyle = C.muted;
      ctx.font = `500 13px NotoSansTCMed, NotoSansCJKFallback`;
      ctx.fillText("Seal", btx, lblY);
    }

    // achievement name
    ctx.fillStyle = achObtained ? C.fg2 : C.muted;
    ctx.font = `bold 14px NotoSansTCBold, NotoSansCJKFallback`;
    ctx.fillText(group.achieve.achievementData.name, btx, lblY + 13 + 6);

    iy += BADGE_H + GAP;
  }

  // ── Progress ──
  const total = group.dungeonGroups.length;
  const normPass = group.dungeonGroups.filter(dg => dg.normalDungeon.isPass).length;
  const hardPass = group.dungeonGroups.filter(dg => dg.hardDungeon.isPass).length;
  const pw = SIDEBAR_W - P * 2;
  drawProgressRow(ctx, "Normal", normPass, total, false, P, iy, pw, 22);
  drawProgressRow(ctx, "Hard", hardPass, total, true,  P, iy + 28, pw, 22);
}

function drawProgressRow(
  ctx: any, label: string, pass: number, total: number, isHard: boolean,
  x: number, y: number, w: number, rowH: number,
) {
  const color = isHard ? C.accent : C.fg2;
  const midY = y + rowH / 2;
 ctx.fillStyle = color;
  ctx.font = `500 14px NotoSansTCMed, NotoSansCJKFallback`;
 ctx.textAlign = "left";
 ctx.textBaseline = "middle";
 ctx.fillText(label,x, midY);

  const LBL_W = 40;
  const CNT_W = 38;
  const SEG_GAP = 4;
  const segAreaW = w - LBL_W - CNT_W;
  const SEG_W = Math.max(6, Math.floor((segAreaW - (total - 1) * SEG_GAP) / total));
  const SX = x + LBL_W;
  for (let i = 0; i < total; i++) {
    const sx = SX + i * (SEG_W + SEG_GAP);
    ctx.fillStyle = i < pass ? color : "rgba(255,255,255,0.08)";
    rr(ctx, sx, midY - 3, SEG_W, 6, 3); ctx.fill();
  }
 ctx.fillStyle = color;
  ctx.font = `bold 14px NotoSansTCBold, NotoSansCJKFallback`;
 ctx.textAlign = "right";
 ctx.textBaseline = "middle";
 ctx.fillText(`${pass}/${total}`,x + w, midY);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIR ROW
// Layout per pair:
//   [TITLE BAR h=TITLE_H]: both dungeon names side by side, no background
//   [H-rule 1px]
//   [CONTENT h=PAIR_H-TITLE_H-1]:
//     each half = [ENEMY STRIP h=ENEMY_H] + [H-rule 1px] + [BODY]
// ─────────────────────────────────────────────────────────────────────────────
function drawPairRow(
  ctx: any, dg: { normalDungeon: IndieHardDungeon; hardDungeon: IndieHardDungeon },
  x: number, py: number,
  eImgs: Map<string, any>, cImgs: Map<string, any>,
  phaseImgs?: Map<number, any>, rankImgs?: Map<number, any>, propImgs?: Map<string, any>,
) {
  // Gap fill (dark) before this pair — only between pairs
  // (gaps already accounted for in py positioning via PAIR_GAP)

  // Merged title row
  drawMergedTitle(ctx, dg.normalDungeon, dg.hardDungeon, x, py, BODY_W, TITLE_H);

  // H-rule
  ctx.fillStyle = C.border2;
  ctx.fillRect(x, py + TITLE_H, BODY_W, 1);

  const contentY = py + TITLE_H + 1;
  const contentH = PAIR_H - TITLE_H - 1;

  drawDungeonHalf(ctx, dg.normalDungeon, false, x, contentY, HALF_W, contentH, eImgs, cImgs, phaseImgs, rankImgs, propImgs);
  drawDungeonHalf(ctx, dg.hardDungeon, true, x + HALF_W + 1, contentY, BODY_W - HALF_W - 1, contentH, eImgs, cImgs, phaseImgs, rankImgs, propImgs);
  // Vertical divider
  ctx.fillStyle = C.border2;
  ctx.fillRect(x + HALF_W, contentY, 1, contentH);
  // Bottom pair gap — dark separator between pairs
  // (gaps already accounted for in py positioning via PAIR_GAP)
  // Draw separator line above this pair (not for first pair)
  if (py > TOP_MARGIN) {
    ctx.fillStyle = C.border2;
    ctx.fillRect(x, py, BODY_W, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGED TITLE BAR (no background)
// ─────────────────────────────────────────────────────────────────────────────
function drawMergedTitle(
  ctx: any,
  normal: IndieHardDungeon, hard: IndieHardDungeon,
  x: number, y: number, w: number, h: number,
) {
  // Subtle bg just for title row
  ctx.fillStyle = C.bg3;
  ctx.fillRect(x, y, w, h);

  const halfW = Math.floor(w / 2);
  const P = 16;
  const midY = y + h / 2;

  // Draw one side of the title
  function drawTitleSide(d: IndieHardDungeon, isHard: boolean, tx: number, tw: number) {
    const modeColor = isHard ? hexAlpha(C.accent, 0.85) : C.muted;
    const modeLabel = isHard ? "Hard" : "Normal";

    // Mode chip (small rounded pill)
  ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
  const chipW = ctx.measureText(modeLabel).width + 14;
    const chipH = 22;
    const chipX = tx + P;
    const chipY = midY - chipH / 2;
    rrFill(ctx, chipX, chipY, chipW, chipH, 4,
      isHard ? "rgba(232,64,64,0.15)" : "rgba(255,255,255,0.06)");
    ctx.fillStyle = modeColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(modeLabel, chipX + chipW / 2, midY);

    // Dungeon name
    const nameX = chipX + chipW + 10;
    // Lv badge on the right
   const lvLabel = `Lv.${d.recommendLevel}`;
    ctx.font = `bold 16px NotoSansLatin`;
   const lvW = ctx.measureText(lvLabel).width + 12;
    const lvX = tx + tw - P - lvW;

    const maxNameW = lvX - nameX - 8;
    ctx.font = `bold 22px NotoSansTCBold, NotoSansCJKFallback`;
    ctx.fillStyle = isHard && !d.isPass ? "#f07060" : C.fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let name = d.name;
    while (name.length > 1 && ctx.measureText(name).width > maxNameW) name = name.slice(0, -1);
    if (name !== d.name) name = name.slice(0, -1) + "…";
    ctx.fillText(name, nameX, midY);

    // Lv badge
    rrFill(ctx, lvX, midY - 12, lvW, 24, 4, "rgba(255,255,255,0.07)");
   ctx.fillStyle = C.fg2;
    ctx.font = `bold 16px NotoSansLatin`;
   ctx.textAlign = "center";
   ctx.textBaseline = "middle";
   ctx.fillText(lvLabel, lvX + lvW / 2, midY);
  }

  drawTitleSide(normal, false, x, halfW);

  // Center divider in title
  ctx.fillStyle = C.border2;
  ctx.fillRect(x + halfW, y + 6, 1, h - 12);

  drawTitleSide(hard, true, x + halfW + 1, BODY_W - halfW - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// DUNGEON HALF  =  enemy strip + body (chars + features)
// ─────────────────────────────────────────────────────────────────────────────
function drawDungeonHalf(
  ctx: any, d: IndieHardDungeon, isHard: boolean,
  x: number, y: number, w: number, h: number,
  eImgs: Map<string, any>, cImgs: Map<string, any>,
  phaseImgs?: Map<number, any>, rankImgs?: Map<number, any>, propImgs?: Map<string, any>,
) {
  // Subtle tint for hard / pass
  if (isHard) {
    ctx.fillStyle = "rgba(232,64,64,0.02)";
    ctx.fillRect(x, y, w, h);
  }
  if (d.isPass) {
    ctx.fillStyle = "rgba(61,179,106,0.025)";
    ctx.fillRect(x, y, w, h);
  }

  // Enemy strip
  drawEnemyStrip(ctx, d, x, y, w, ENEMY_H, eImgs);

  // H-rule
  ctx.fillStyle = C.border;
  ctx.fillRect(x, y + ENEMY_H, w, 1);

  // Body
  const bodyY = y + ENEMY_H + 1;
  const bodyH = h - ENEMY_H - 1;
  drawBody(ctx, d, x, bodyY, w, bodyH, cImgs, phaseImgs, rankImgs, propImgs);
}

// ── Enemy strip ───────────────────────────────────────────────────────────────
function drawEnemyStrip(
  ctx: any, d: IndieHardDungeon,
  x: number, y: number, w: number, h: number,
  eImgs: Map<string, any>,
) {
  const P = 14;
  const ESZ = 64;
  const GAP = 16;

  // No background for enemy area — transparent

  // Label
 ctx.fillStyle = C.muted;
  ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
 ctx.textAlign = "left";
 ctx.textBaseline = "middle";
 ctx.fillText("Enemies", x + P, y + h / 2);

  const seen = new Set<string>();
  const enemies = d.enemies.filter(e => !seen.has(e.id) && seen.add(e.id));
  const LBL_W = ctx.measureText("Enemies").width + P + 16;

  ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
  const NAME_MARGIN = 6; // padding on each side of name
  // Cell width = max(ESZ, nameWidth) + NAME_MARGIN*2
  const cellWidths = enemies.map(e => {
    const nw = ctx.measureText(e.name).width;
    return Math.max(ESZ, nw) + NAME_MARGIN * 2;
  });

  const totalCellW = cellWidths.reduce((a, b) => a + b, 0) + GAP * (enemies.length - 1);
  // Right-align enemies
  const eStartX = x + w - P - totalCellW;
  const eY = y + (h - ESZ - 20) / 2; // leave 20px for name below

  let curX = eStartX;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const cw = cellWidths[i];
    const imgX = curX + (cw - ESZ) / 2;
    rrFill(ctx, imgX, eY, ESZ, ESZ, 6, C.bg3);
    rrStroke(ctx, imgX, eY, ESZ, ESZ, 6, C.border2, 1);
    const img = eImgs.get(e.id);
    if (img) {
      ctx.save(); rr(ctx, imgX, eY, ESZ, ESZ, 6); ctx.clip();
      drawImageCover(ctx, img, imgX, eY, ESZ, ESZ);
      ctx.restore();
    }
    // Name below — single line, centered in cell
    ctx.fillStyle = C.fg2;
    ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillText(e.name, curX + cw / 2, eY + ESZ + 4);
    curX += cw + GAP;
  }
}

// ── Body = chars (left) + features (right) ───────────────────────────────────
function drawBody(
  ctx: any, d: IndieHardDungeon,
  x: number, y: number, w: number, h: number,
  cImgs: Map<string, any>,
  phaseImgs?: Map<number, any>, rankImgs?: Map<number, any>, propImgs?: Map<string, any>,
) {
  // Split: chars 60%, features 40%
  const FEAT_W = Math.floor(w * 0.40);
  const CHAR_W = w - FEAT_W - 1;

  // Vertical separator
  ctx.fillStyle = C.border;
  ctx.fillRect(x + CHAR_W, y, 1, h);

  drawChars(ctx, d, x, y, CHAR_W, h, cImgs, phaseImgs, rankImgs, propImgs);
  drawFeatures(ctx, d, x + CHAR_W + 1, y, FEAT_W, h);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHARS  (profile-style avatars with property icon + phase/rank pill)
// ─────────────────────────────────────────────────────────────────────────────
function drawChars(
  ctx: any, d: IndieHardDungeon,
  x: number, y: number, w: number, h: number,
  cImgs: Map<string, any>,
  phaseImgs?: Map<number, any>, rankImgs?: Map<number, any>, propImgs?: Map<string, any>,
) {
  if (!d.bestRecord || d.bestRecord.chars.length === 0) {
    ctx.fillStyle = C.muted;
    ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No Clear Record", x + w / 2, y + h / 2);
    return;
  }

  const chars = d.bestRecord.chars.slice(0, 4);
  const sec   = parseInt(d.bestRecord.passTs, 10);

  const P      = 14;
  const TIME_H = 22;

  // Smaller char size to leave room for features
  const availH  = h - TIME_H - 8 - P * 2;
  const CHAR_GAP = 8;
  // Cap max size so they don't crowd out features
  const CHAR_SZ  = Math.min(
    Math.min(availH, 90),
    Math.floor((w - P * 2 - (chars.length - 1) * CHAR_GAP) / chars.length),
  );

  const totalCharW = chars.length * CHAR_SZ + (chars.length - 1) * CHAR_GAP;
  const charStartX = x + Math.floor((w - totalCharW) / 2);

  const blockH   = TIME_H + 8 + CHAR_SZ;
  const blockY   = y + Math.floor((h - blockH) / 2);
  const timeY    = blockY;
  const charY    = blockY + TIME_H + 8;

  // Time
  ctx.fillStyle = hexAlpha(C.gold, 0.85);
  ctx.font = `bold 18px NotoSansLatin`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtTime(sec), charStartX, timeY + TIME_H / 2);

  if (d.bestRecord.ts) {
    ctx.fillStyle = hexAlpha(C.muted, 0.7);
    ctx.font = `500 16px NotoSansLatin`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtDate(d.bestRecord.ts), charStartX + totalCharW, timeY + TIME_H / 2);
  }

  // Character avatars
  for (let i = 0; i < chars.length; i++) {
    const ch  = chars[i];
    const col = rarityCol(ch.rarity.key);
    const cx  = charStartX + i * (CHAR_SZ + CHAR_GAP);

    // White card background
    ctx.save();
    rr(ctx, cx, charY, CHAR_SZ, CHAR_SZ, 8);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.clip();

    // Avatar
    const img = cImgs.get(ch.charId);
    if (img) drawImageCover(ctx, img, cx, charY, CHAR_SZ, CHAR_SZ);
    else {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.fillRect(cx, charY, CHAR_SZ, CHAR_SZ);
    }

    // Rarity bar at very bottom (6px) — use rarityCol
    ctx.fillStyle = col;
    ctx.fillRect(cx, charY + CHAR_SZ - 6, CHAR_SZ, 6);

    ctx.restore();

    // Lv text overlay (bottom-left, white with black stroke)
    const LV_FS = 13;
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    const lvPrefix = "Lv.";
    ctx.font = `500 ${LV_FS}px NotoSansLatin`;
    ctx.strokeText(lvPrefix, cx + 4, charY + CHAR_SZ - 6);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(lvPrefix, cx + 4, charY + CHAR_SZ - 6);
    const prefW = ctx.measureText(lvPrefix).width;
    ctx.font = `bold ${LV_FS + 3}px NotoSansLatin`;
    ctx.strokeText(`${ch.level}`, cx + 4 + prefW, charY + CHAR_SZ - 6);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${ch.level}`, cx + 4 + prefW, charY + CHAR_SZ - 6);
    ctx.restore();

    // Property icon (top-left corner) — replace 精X
    const PROP_SZ = Math.floor(CHAR_SZ * 0.28);
    const propKey = ch.property.key.replace("char_property_", ""); // e.g. "fire"
    const propImg = propImgs?.get(propKey);
    if (propImg) {
      ctx.save();
      rr(ctx, cx + 2, charY + 2, PROP_SZ, PROP_SZ, 3);
      ctx.fillStyle = "rgba(20,20,30,0.65)";
      ctx.fill();
      ctx.drawImage(propImg, cx + 2, charY + 2, PROP_SZ, PROP_SZ);
      ctx.restore();
    } else {
      // fallback: small text pill
      const pillW = 28; const pillH = 14;
      rrFill(ctx, cx + 2, charY + 2, pillW, pillH, 3, "rgba(20,20,30,0.75)");
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = `bold 9px NotoSansTCBold, NotoSansCJKFallback`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(ch.property.value, cx + 2 + pillW / 2, charY + 2 + pillH / 2);
    }

    // Phase + rank pill (bottom-right, profile style) — evolvePhase & potentialLevel
    const PILL_H = 16;
    const phaseImg = phaseImgs?.get(ch.evolvePhase);
    const rankImg  = rankImgs?.get(ch.potentialLevel);
    const pillIconSz = 12;
    // Measure pill: [phaseIcon][rankIcon] w/ small gap
    const pillIcons = [phaseImg, rankImg].filter(Boolean);
    const pillW2 = pillIcons.length * (pillIconSz + 2) + 4;
    const pillX = cx + CHAR_SZ - 2 - pillW2;
    const pillY = charY + CHAR_SZ - PILL_H - 8; // above rarity bar
    rrFill(ctx, pillX, pillY, pillW2, PILL_H, 3, "rgba(15,15,22,0.82)");
    let ix = pillX + 2;
    for (const pim of pillIcons) {
      ctx.drawImage(pim, ix, pillY + (PILL_H - pillIconSz) / 2, pillIconSz, pillIconSz);
      ix += pillIconSz + 2;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURES  (wrapped, fully shown)
// ─────────────────────────────────────────────────────────────────────────────
function drawFeatures(
  ctx: any, d: IndieHardDungeon,
  x: number, y: number, w: number, h: number,
) {
  const P        = 14;
  const chipW    = w - P * 2;
  const FONT     = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
  const LINE_H   = 24;
  const CHIP_PV  = 8;   // vertical padding inside chip
  const CHIP_GAP = 5;

  const features = parseFeatures(d.feature);
  const sorted   = [...features.filter(f => !f.warn), ...features.filter(f => f.warn)];

  // Pre-compute wrapped lines per feature
  ctx.font = FONT;
  const chips = sorted.map(feat => {
    const lines  = wrapText(ctx, feat.text, chipW - 16);
    const chipH  = lines.length * LINE_H + CHIP_PV * 2;
    return { feat, lines, chipH };
  });

  const LBL_H   = 18;
  const totalH  = LBL_H + 8
    + chips.reduce((s, c) => s + c.chipH + CHIP_GAP, 0)
    - (chips.length > 0 ? CHIP_GAP : 0);

  // Vertically centre
  let cy = y + Math.max(P, Math.floor((h - totalH) / 2));

  // Section label
  ctx.fillStyle = C.muted;
  ctx.font = `500 16px NotoSansTCMed, NotoSansCJKFallback`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("Stage Modifiers", x + P, cy);
  cy += LBL_H + 8;

  for (const { feat, lines, chipH } of chips) {
    // Stop if overflows
    if (cy + chipH > y + h - 4) break;

    // Chip background
    ctx.fillStyle = feat.warn ? "rgba(232,64,64,0.07)" : "rgba(255,255,255,0.04)";
    ctx.fillRect(x + P, cy, chipW, chipH);
    // Left accent bar
    ctx.fillStyle = feat.warn ? C.accent : "rgba(255,255,255,0.18)";
    ctx.fillRect(x + P, cy, 2, chipH);

    // Text lines
    ctx.fillStyle = feat.warn ? "rgba(250,170,110,0.95)" : C.fg2;
    ctx.font = FONT;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (let li = 0; li < lines.length; li++) {
      ctx.fillText(lines[li], x + P + 10, cy + CHIP_PV + li * LINE_H);
    }

    cy += chipH + CHIP_GAP;
  }
}
