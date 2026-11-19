import { createCanvas, loadImage } from "@napi-rs/canvas";
import path from "path";
import { drawProfileBackground, fetchImage } from "./canvasUtils";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import { StaminaView, formatDuration, Gauge } from "./staminaView";

// Fonts ("NotoSans" regular, "NotoSansTCBold", "OrbitronBold") are registered by canvasUtils.
export const STAMINA_CARD_WIDTH = 1200;

const PAD = 40;
const GAP = 24;
const HEADER_H = 150;
const HERO_H = 270;
const TILE_H = 200;
const FOOTER_H = 64;
const ASSET_DIR = path.join(__dirname, "../assets/player");

type Ctx = any;

function panel(ctx: Ctx, x: number, y: number, w: number, h: number, highlighted = false) {
  ctx.fillStyle = highlighted ? "rgba(83,94,35,0.92)" : "rgba(23,29,34,0.92)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.fillStyle = highlighted ? "#e2ee89" : "#dbe5df";
  ctx.fillRect(x, y + 20, 5, 34);
}

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  size: number,
  opts: { bold?: boolean; color?: string; align?: "left" | "right" | "center"; font?: string; maxW?: number } = {},
) {
  let s = size;
  const family = opts.font ?? (opts.bold ? "NotoSansTCBold" : "NotoSans");
  ctx.font = `${s}px ${family}`;
  if (opts.maxW) {
    while (s > 12 && ctx.measureText(value).width > opts.maxW) {
      s -= 1;
      ctx.font = `${s}px ${family}`;
    }
  }
  ctx.fillStyle = opts.color ?? "#fff";
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "top";
  ctx.fillText(value, x, y);
  ctx.textAlign = "left";
}

function bar(ctx: Ctx, x: number, y: number, w: number, h: number, ratio: number, fill: string) {
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  if (ratio > 0) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(h, w * ratio), h, h / 2);
    ctx.fill();
  }
}

async function asset(name: string): Promise<any | null> {
  try {
    return await loadImage(path.join(ASSET_DIR, name));
  } catch {
    return null;
  }
}

function iconTile(ctx: Ctx, img: any, x: number, y: number, size: number, light: boolean) {
  ctx.fillStyle = light ? "#e7e9e7" : "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 10);
  ctx.fill();
  if (!img) return;
  const box = size * 0.76;
  const r = Math.min(box / img.width, box / img.height);
  ctx.drawImage(img, x + (size - img.width * r) / 2, y + (size - img.height * r) / 2, img.width * r, img.height * r);
}

const fmtNum = (n: number) => String(Math.round(n * 10) / 10);

/** "11/19 18:12 UTC+8": fixed zone; the message text carries the viewer-local Discord timestamp. */
export function formatClock(ms: number, lang: string): string {
  const s = new Date(ms).toLocaleString(lang === "tw" ? "zh-TW" : "en-GB", {
    timeZone: "Asia/Taipei",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${s} UTC+8`;
}

export async function buildStaminaCard(view: StaminaView, tr: any, now = Date.now()): Promise<Buffer> {
  const lang: string = tr.lang;
  const W = STAMINA_CARD_WIDTH;
  const inner = W - PAD * 2;
  const tiles: Array<{ key: "daily" | "weekly" | "pass"; gauge: Gauge }> = [];
  if (view.daily) tiles.push({ key: "daily", gauge: view.daily });
  if (view.weekly) tiles.push({ key: "weekly", gauge: view.weekly });
  if (view.pass) tiles.push({ key: "pass", gauge: view.pass });

  let H = HEADER_H;
  if (view.sanity) H += HERO_H + GAP;
  if (tiles.length) H += TILE_H + GAP;
  H += FOOTER_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as Ctx;
  await drawProfileBackground(ctx, W, H, ProfileTemplateService.getDefaultTemplate());

  // Header: avatar, title, role line.
  let avatar: any = null;
  if (view.header.avatarUrl) avatar = await fetchImage(view.header.avatarUrl).catch(() => null);
  if (!avatar) avatar = await asset("../logo.png");
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.roundRect(PAD, 28, 100, 100, 12);
  ctx.fill();
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD, 28, 100, 100, 12);
    ctx.clip();
    const r = Math.max(100 / avatar.width, 100 / avatar.height);
    ctx.drawImage(avatar, PAD + (100 - avatar.width * r) / 2, 28 + (100 - avatar.height * r) / 2, avatar.width * r, avatar.height * r);
    ctx.restore();
  }
  text(ctx, tr("stamina_Title"), PAD + 124, 26, 44, { bold: true, maxW: 700 });
  const who = [
    view.header.name || "Endministrator",
    view.header.level ? `Lv.${view.header.level}` : "",
    view.header.roleId ? `UID ${view.header.roleId}` : "",
    view.header.serverName,
  ]
    .filter(Boolean)
    .join("  ·  ");
  text(ctx, who, PAD + 124, 86, 26, { bold: true, color: "#dbe5df", maxW: inner - 124 });

  let y = HEADER_H;

  // Sanity hero.
  if (view.sanity) {
    const s = view.sanity;
    const full = s.state === "full";
    panel(ctx, PAD, y, inner, HERO_H, full);
    iconTile(ctx, await asset("sanity-icon.svg"), PAD + 28, y + 24, 72, true);
    text(ctx, tr("stamina_Sanity"), PAD + 120, y + 40, 30, { bold: true });
    text(ctx, fmtNum(s.cur), PAD + 28, y + 110, 84, { font: "OrbitronBold" });
    ctx.font = "84px OrbitronBold";
    const curW = ctx.measureText(fmtNum(s.cur)).width;
    text(ctx, `/ ${fmtNum(s.max)}`, PAD + 28 + curW + 16, y + 142, 40, { color: "rgba(255,255,255,0.62)", font: "OrbitronBold" });
    const rx = PAD + inner - 28;
    if (full) {
      text(ctx, tr("stamina_Full"), rx, y + 40, 52, { bold: true, align: "right", color: "#e2ee89" });
    } else {
      text(ctx, tr("stamina_TimeToFull"), rx, y + 24, 22, { align: "right", color: "rgba(255,255,255,0.7)" });
      text(ctx, s.remainingMs != null ? formatDuration(s.remainingMs, tr("Hour"), tr("Minute")) : "—", rx, y + 52, 46, { bold: true, align: "right", maxW: 480 });
      text(ctx, tr("stamina_FullAt"), rx, y + 116, 22, { align: "right", color: "rgba(255,255,255,0.7)" });
      text(ctx, s.fullAtMs != null ? formatClock(s.fullAtMs, lang) : "—", rx, y + 144, 34, { bold: true, align: "right", maxW: 480 });
    }
    bar(ctx, PAD + 28, y + HERO_H - 44, inner - 56, 22, s.ratio, full ? "#e2ee89" : "#8fd3ff");
    y += HERO_H + GAP;
  }

  // Progress tiles share one row, widths split evenly.
  if (tiles.length) {
    const w = (inner - GAP * (tiles.length - 1)) / tiles.length;
    const icons = { daily: ["daily.svg", true], weekly: ["realtime.png", false], pass: ["medals.png", false] } as const;
    const titles = { daily: "stamina_Daily", weekly: "stamina_Weekly", pass: "stamina_Pass" } as const;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const x = PAD + i * (w + GAP);
      const done = t.gauge.cur >= t.gauge.max;
      panel(ctx, x, y, w, TILE_H, false);
      iconTile(ctx, await asset(icons[t.key][0]), x + 24, y + 22, 56, icons[t.key][1]);
      text(ctx, tr(titles[t.key]), x + 96, y + 34, 26, { bold: true, maxW: w - 96 - 20 });
      text(ctx, fmtNum(t.gauge.cur), x + 28, y + 96, 48, { font: "OrbitronBold" });
      ctx.font = "48px OrbitronBold";
      const cw = ctx.measureText(fmtNum(t.gauge.cur)).width;
      text(ctx, `/ ${fmtNum(t.gauge.max)}`, x + 28 + cw + 10, y + 112, 26, { color: "rgba(255,255,255,0.62)", font: "OrbitronBold" });
      bar(ctx, x + 28, y + TILE_H - 40, w - 56, 14, t.gauge.ratio, done ? "#e2ee89" : "#dbe5df");
    }
    y += TILE_H + GAP;
  }

  const stamp = (ms: number) => formatClock(ms, lang);
  const parts = [
    view.header.savedAtMs ? `${tr("stamina_Saved")}  ${stamp(view.header.savedAtMs)}` : "",
    `${tr("stamina_Queried")}  ${stamp(now)}`,
  ].filter(Boolean);
  text(ctx, parts.join("      "), PAD, H - FOOTER_H + 8, 19, { color: "#d0d4d7", maxW: inner });

  return canvas.toBuffer("image/png");
}
