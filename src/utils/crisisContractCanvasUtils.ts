import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import axios from "axios";
import path from "path";

export const CRISIS_CONTRACT_CARD_SIZE = { width: 1536, height: 864 } as const;

const fontDir = path.join(__dirname, "../assets/fonts");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-TC-400.woff2"), "NotoSansTC");
GlobalFonts.registerFromPath(path.join(fontDir, "Noto-Sans-TC-700.woff2"), "NotoSansTCBold");

const imageCache = new Map<string, Buffer>();

async function fetchImage(url?: string): Promise<any | null> {
  if (!url) return null;
  try {
    let buf = imageCache.get(url);
    if (!buf) {
      const res = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 10000 });
      buf = Buffer.from(res.data);
      if (imageCache.size > 300) imageCache.clear();
      imageCache.set(url, buf);
    }
    return loadImage(buf);
  } catch {
    return null;
  }
}

function rect(ctx: any, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function line(ctx: any, x: number, y: number, w: number, h: number, color = "rgba(255,255,255,0.18)") {
  rect(ctx, x, y, w, h, color);
}

function cover(ctx: any, img: any, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

function clipRect(ctx: any, x: number, y: number, w: number, h: number, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  draw();
  ctx.restore();
}

function fitText(ctx: any, text: string, maxW: number, size: number, weight = "bold") {
  while (size > 14) {
    ctx.font = `${weight} ${size}px NotoSansTCBold`;
    if (ctx.measureText(text).width <= maxW) break;
    size -= 2;
  }
  return size;
}

function fmtTime(raw: unknown) {
  const sec = Math.max(0, Number(raw || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function drawGlassPanel(ctx: any, x: number, y: number, w: number, h: number, color = "rgba(10,12,18,0.72)") {
  rect(ctx, x + 8, y + 10, w, h, "rgba(0,0,0,0.22)");
  rect(ctx, x, y, w, h, color);
  line(ctx, x, y, w, 1, "rgba(255,255,255,0.22)");
  line(ctx, x, y, 1, h, "rgba(255,255,255,0.12)");
}

function drawPlaceholder(ctx: any, x: number, y: number, w: number, h: number, label: string) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#30343f");
  g.addColorStop(1, "#11131a");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.46)";
  ctx.font = "bold 42px NotoSansTCBold";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label.slice(0, 1) || "?", x + w / 2, y + h / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function getCharId(char: any) {
  return char?.charId ?? char?.id ?? char?.charData?.id;
}

function getIconUrl(item: any) {
  return item?.iconUrl ?? item?.equipData?.iconUrl ?? item?.weaponData?.iconUrl;
}

function drawStat(ctx: any, x: number, y: number, w: number, label: string, value: string, hot = false) {
  drawGlassPanel(ctx, x, y, w, 104, hot ? "rgba(210,20,28,0.92)" : "rgba(38,42,52,0.82)");
  ctx.fillStyle = hot ? "rgba(255,255,255,0.84)" : "rgba(255,255,255,0.68)";
  ctx.font = "22px NotoSansTC";
  ctx.fillText(label, x + 22, y + 16);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${fitText(ctx, value, w - 44, hot ? 70 : 48)}px NotoSansTCBold`;
  ctx.fillText(value, x + 22, y + 46);
}

function drawIndicatorGrid(ctx: any, indicators: any[], active: number) {
  const x0 = 72;
  const y0 = 372;
  const cell = 86;
  for (let i = 0; i < 12; i++) {
    const x = x0 + (i % 6) * cell;
    const y = y0 + Math.floor(i / 6) * cell;
    rect(ctx, x, y, 76, 76, "rgba(0,0,0,0.54)");
    ctx.strokeStyle = i < active ? "#e5bd3b" : "rgba(255,255,255,0.16)";
    ctx.lineWidth = i < active ? 3 : 1;
    ctx.strokeRect(x, y, 76, 76);

    if (indicators[i]?.image) {
      ctx.drawImage(indicators[i].image, x + 14, y + 14, 48, 48);
    } else {
      ctx.fillStyle = i < active ? "#fff" : "rgba(255,255,255,0.38)";
      ctx.font = "bold 28px NotoSansTCBold";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x + 38, y + 38);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }
  }
}

function drawRankMarks(ctx: any, x: number, y: number, active: number) {
  for (let i = 0; i < 4; i++) {
    const bx = x + i * 52;
    rect(ctx, bx, y, 36, 42, i < active ? "#ba1720" : "rgba(120,20,24,0.58)");
    line(ctx, bx + 5, y + 6, 26, 2, "#fff");
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(["I", "II", "III", "IV"][i], bx + 18, y + 18);
  }
  ctx.textAlign = "left";
}

function drawCharacterCard(ctx: any, char: any, x: number, y: number, avatar: any, weapon: any, equips: any[]) {
  const w = 154;
  const h = 684;
  drawGlassPanel(ctx, x, y, w, h, "rgba(8,10,14,0.84)");
  line(ctx, x, y, w, 4, "#e7bd37");

  clipRect(ctx, x, y, w, 324, () => {
    if (avatar) cover(ctx, avatar, x, y, w, 324);
    else drawPlaceholder(ctx, x, y, w, 324, char?.name || char?.charId || "");
  });

  const fade = ctx.createLinearGradient(0, y + 180, 0, y + 348);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,0.92)");
  ctx.fillStyle = fade;
  ctx.fillRect(x, y + 180, w, 180);

  ctx.fillStyle = "rgba(255,255,255,0.76)";
  ctx.font = "18px NotoSansTC";
  ctx.fillText("Lv.", x + 16, y + 286);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 48px NotoSansTCBold";
  ctx.fillText(String(char?.level ?? "-"), x + 16, y + 306);
  ctx.fillStyle = "#d8ff31";
  ctx.font = "bold 21px NotoSansTCBold";
  ctx.fillText(`P${char?.potentialLevel ?? 0}`, x + 98, y + 330);

  rect(ctx, x + 10, y + 390, w - 20, 82, "rgba(0,0,0,0.46)");
  if (weapon?.image) cover(ctx, weapon.image, x + 14, y + 398, 62, 62);
  else drawPlaceholder(ctx, x + 14, y + 398, 62, 62, "W");
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "15px NotoSansTC";
  ctx.fillText("Weapon", x + 82, y + 404);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 25px NotoSansTCBold";
  ctx.fillText(`Lv.${weapon?.level ?? "-"}`, x + 82, y + 426);
  ctx.fillStyle = "#d8ff31";
  ctx.font = "bold 18px NotoSansTCBold";
  ctx.fillText(`R${weapon?.refineLevel ?? 0}`, x + 104, y + 452);

  for (let i = 0; i < 4; i++) {
    const ex = x + 14 + (i % 2) * 66;
    const ey = y + 502 + Math.floor(i / 2) * 62;
    rect(ctx, ex, ey, 58, 54, "rgba(0,0,0,0.52)");
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ex, ey, 58, 54);
    if (equips[i]) cover(ctx, equips[i], ex + 4, ey + 2, 50, 50);
  }
}

export async function buildCrisisContractCard(payload: {
  roleName: string;
  roleLevel?: number;
  crisisContract: any;
  detail?: any;
}): Promise<Buffer> {
  const { width: W, height: H } = CRISIS_CONTRACT_CARD_SIZE;
  const cc = payload.crisisContract;
  const status = cc?.status || {};
  const best = cc?.history?.bestRecord || null;
  const rawIndicators = Array.isArray(cc?.indicators) ? cc.indicators.slice(0, 12) : [];
  const bestChars = Array.isArray(best?.chars) ? best.chars.slice(0, 4) : [];
  const detailChars = Array.isArray(payload.detail?.chars) ? payload.detail.chars : [];

  const indicators = await Promise.all(
    rawIndicators.map(async (item: any) => ({ ...item, image: await fetchImage(item?.icon) })),
  );
  const enrichedChars = bestChars.map((char: any) => {
    const id = getCharId(char);
    const detail = detailChars.find((x: any) => x?.charData?.id === id || x?.id === id || x?.charId === id);
    return { ...char, detail };
  });
  const charAssets = await Promise.all(
    enrichedChars.map(async (char: any) => {
      const detail = char.detail || {};
      const equips = ["bodyEquip", "armEquip", "firstAccessory", "secondAccessory"];
      return {
        avatar: await fetchImage(char.avatarUrl || detail?.avatarUrl || detail?.charData?.avatarUrl),
        weapon: {
          level: detail?.weapon?.level ?? char?.weapon?.level,
          refineLevel: detail?.weapon?.refineLevel ?? char?.weapon?.refineLevel,
          image: await fetchImage(getIconUrl(detail?.weapon) || getIconUrl(char?.weapon)),
        },
        equips: await Promise.all(equips.map((key) => fetchImage(getIconUrl(detail?.[key])))),
      };
    }),
  );

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as any;
  ctx.textBaseline = "top";

  const bg = await fetchImage(status.kvImage || status.headerImage || cc?.dungeon?.imageUrl);
  if (bg) {
    cover(ctx, bg, 0, 0, W, H);
    rect(ctx, 0, 0, W, H, "rgba(8,10,16,0.62)");
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#411012");
    g.addColorStop(0.48, "#202833");
    g.addColorStop(1, "#100f14");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  rect(ctx, 0, 0, 550, H, "rgba(170,0,0,0.22)");
  rect(ctx, 0, H - 24, W, 24, "#df1720");
  line(ctx, 36, 96, 4, 690, "rgba(255,255,255,0.72)");

  ctx.fillStyle = "rgba(255,255,255,0.76)";
  ctx.font = "23px NotoSansTC";
  ctx.fillText("// 行動結果", 58, 34);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 70px NotoSansTCBold";
  ctx.fillText("行動成功", 58, 116);
  line(ctx, 60, 206, 256, 5, "#e7bd37");
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "bold 26px NotoSansTCBold";
  ctx.fillText(status.name || "危機合約", 62, 226);
  drawRankMarks(ctx, 542, 166, Math.min(4, Math.max(1, Math.ceil(Number(best?.indicatorCount || status.highest || 0) / 8))));

  drawStat(ctx, 58, 274, 386, "指標總計", String(status.highest ?? 0), true);
  drawStat(ctx, 458, 274, 266, "行動時長", fmtTime(best?.passTs), false);
  drawIndicatorGrid(ctx, indicators, Number(best?.indicatorCount || indicators.length || 0));

  drawGlassPanel(ctx, 58, 700, 666, 66, "rgba(0,0,0,0.58)");
  ctx.fillStyle = "#fff";
  ctx.font = "22px NotoSansTC";
  ctx.fillText("里程碑已更新為新的評價", 88, 720);
  ctx.textAlign = "right";
  ctx.font = "bold 28px NotoSansTCBold";
  ctx.fillStyle = "#f0d486";
  ctx.fillText(`${status.highest ?? 0}`, 700, 716);
  ctx.textAlign = "left";

  for (let i = 0; i < 4; i++) {
    const x = 792 + i * 176;
    const char = enrichedChars[i] || { charId: "-", level: "-", potentialLevel: 0 };
    const assets = charAssets[i] || { avatar: null, weapon: {}, equips: [] };
    drawCharacterCard(ctx, char, x, 54, assets.avatar, assets.weapon, assets.equips);
  }

  drawGlassPanel(ctx, 792, 758, 682, 62, "rgba(0,0,0,0.46)");
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "20px NotoSansTC";
  ctx.fillText(`${payload.roleName}${payload.roleLevel ? `  Lv.${payload.roleLevel}` : ""}`, 816, 776);
  ctx.textAlign = "right";
  ctx.fillText(`挑戰 ${status.challengeCount ?? 0} / 記錄 ${cc?.history?.records?.length ?? 0}`, 1448, 776);
  ctx.textAlign = "left";

  // ponytail: smoke-test dimensions catch broken output; pixel tests are too brittle for a canvas card.
  return canvas.toBuffer("image/png");
}
