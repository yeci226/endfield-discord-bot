import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import axios from "axios";
import moment from "moment-timezone";
import { Translator } from "./i18n";

const fontDir = path.join(__dirname, "../assets/fonts");
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-400.woff2"),
  "NotoSans",
);
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-700.woff2"),
  "NotoSansBold",
);

export interface DailyRewardItem {
  name: string;
  icon?: string;
  done?: boolean;
}

export interface DailyCardPayload {
  roleName: string;
  roleMeta: string;
  totalDays: number;
  calendarTotalDays: number;
  todayClaimedNow?: boolean;
  checkedDaysThisMonth?: number;
  missedDaysThisMonth?: number;
  yesterdayReward: DailyRewardItem;
  todayReward: DailyRewardItem;
  nextRewards: DailyRewardItem[];
  tr: Translator;
}

const imageCache = new Map<string, Buffer>();

async function loadImageBuffer(url: string): Promise<Buffer> {
  const cached = imageCache.get(url);
  if (cached) return cached;

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 10000,
  });
  const buf = Buffer.from(res.data);
  imageCache.set(url, buf);
  return buf;
}

function roundedRect(
  ctx: any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

async function drawRewardIcon(
  ctx: any,
  iconUrl: string | undefined,
  x: number,
  y: number,
  size: number,
  locked: boolean,
) {
  ctx.save();
  if (iconUrl) {
    try {
      const iconBuffer = await loadImageBuffer(iconUrl);
      const icon = await loadImage(iconBuffer);
      const ratio = Math.min(size / icon.width, size / icon.height);
      const drawW = icon.width * ratio;
      const drawH = icon.height * ratio;
      const offsetX = x + (size - drawW) / 2;
      const offsetY = y + (size - drawH) / 2;
      ctx.drawImage(icon, offsetX, offsetY, drawW, drawH);
    } catch {
      ctx.fillStyle = "rgba(180, 190, 210, 0.25)";
      ctx.font = "bold 26px NotoSansBold";
      ctx.fillText("?", x + size / 2 - 8, y + size / 2 + 10);
    }
  } else {
    ctx.fillStyle = "rgba(180, 190, 210, 0.25)";
    ctx.font = "bold 26px NotoSansBold";
    ctx.fillText("?", x + size / 2 - 8, y + size / 2 + 10);
  }

  ctx.restore();
}

function fitText(
  ctx: any,
  text: string,
  maxWidth: number,
  initialSize: number,
  minSize = 16,
): number {
  let size = initialSize;
  while (size > minSize) {
    ctx.font = `${size}px NotoSans`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

export async function buildDailyAttendanceCard(
  payload: DailyCardPayload,
): Promise<Buffer> {
  const width = 1280;
  const height = 720;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, "#171b2a");
  bgGradient.addColorStop(0.5, "#10232c");
  bgGradient.addColorStop(1, "#1f1c2f");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  const panelX = 48;
  const panelY = 42;
  const panelW = width - panelX * 2;
  const panelH = height - panelY * 2;

  roundedRect(ctx, panelX, panelY, panelW, panelH, 24);
  ctx.fillStyle = "rgba(9, 12, 18, 0.58)";
  ctx.fill();
  ctx.strokeStyle = "rgba(152, 214, 255, 0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#f8fbff";
  ctx.font = "bold 44px NotoSansBold";
  ctx.fillText(payload.roleName, panelX + 38, panelY + 70);

  ctx.fillStyle = "#a8bed1";
  ctx.font = "30px NotoSans";
  ctx.fillText(payload.roleMeta, panelX + 40, panelY + 116);

  const badgeX = panelX + panelW - 360;
  const badgeY = panelY + 44;
  roundedRect(ctx, badgeX, badgeY, 300, 84, 18);
  ctx.fillStyle = "rgba(138, 255, 198, 0.14)";
  ctx.fill();
  ctx.strokeStyle = "rgba(170, 255, 216, 0.44)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#b8ffdd";
  ctx.font = "25px NotoSans";
  ctx.fillText(
    payload.tr("daily_canvas_TotalCheckIn"),
    badgeX + 24,
    badgeY + 33,
  );
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px NotoSansBold";
  const totalLabel =
    payload.calendarTotalDays > 0
      ? `${payload.totalDays}/${payload.calendarTotalDays} 天`
      : `${payload.totalDays} 天`;
  ctx.fillText(totalLabel, badgeX + 24, badgeY + 71);

  const timelineY = panelY + 360;
  const leftStartX = panelX + 36;
  const cardW = 200;
  const cardH = 260;
  const cardGap = 28;
  const base = moment().tz("Asia/Taipei").startOf("day");
  const labels = [-1, 0, 1, 2, 3].map((offset) =>
    base.clone().add(offset, "day").format("M/D"),
  );
  const items = [
    payload.yesterdayReward || { name: "-", icon: "", done: true },
    payload.todayReward || { name: "-", icon: "", done: false },
    payload.nextRewards[0] || { name: "-", icon: "" },
    payload.nextRewards[1] || { name: "-", icon: "" },
    payload.nextRewards[2] || { name: "-", icon: "" },
  ];
  const textMax = cardW - 32;
  const unifiedNameFontSize = items.reduce((minSize, item) => {
    const name = item.name || "-";
    const size = fitText(ctx, name, textMax, 34, 18);
    return Math.min(minSize, size);
  }, 34);

  ctx.fillStyle = "#d7e5f2";
  ctx.font = "bold 30px NotoSansBold";
  ctx.fillText(
    payload.tr("daily_canvas_CheckinRewards"),
    leftStartX,
    timelineY - 170,
  );

  for (let i = 0; i < items.length; i++) {
    const x = leftStartX + i * (cardW + cardGap);
    const y = timelineY - cardH / 2;
    const item = items[i];
    const isToday = i === 1;
    const isFuture = i >= 2;
    const isPast = i === 0;
    const todayIsClaimed = !!(payload.todayClaimedNow || item.done);

    roundedRect(ctx, x, y, cardW, cardH, 18);
    if (isToday) {
      if (todayIsClaimed) {
        ctx.fillStyle = "rgba(50, 93, 115, 0.28)";
        ctx.strokeStyle = "rgba(122, 188, 226, 0.42)";
      } else {
        ctx.fillStyle = "rgba(76, 124, 102, 0.24)";
        ctx.strokeStyle = "rgba(137, 237, 180, 0.48)";
      }
    } else if (isPast) {
      if (item.done) {
        ctx.fillStyle = "rgba(50, 93, 115, 0.28)";
        ctx.strokeStyle = "rgba(122, 188, 226, 0.42)";
      } else {
        ctx.fillStyle = "rgba(58, 62, 72, 0.72)";
        ctx.strokeStyle = "rgba(170, 178, 193, 0.22)";
      }
    } else {
      ctx.fillStyle = "rgba(58, 62, 72, 0.72)";
      ctx.strokeStyle = "rgba(170, 178, 193, 0.22)";
    }
    ctx.fill();
    ctx.lineWidth = isToday ? 1.8 : 1;
    ctx.stroke();

    const iconSize = 124;
    const iconX = x + (cardW - iconSize) / 2;
    const iconY = y + 52;
    await drawRewardIcon(ctx, item.icon, iconX, iconY, iconSize, isFuture);

    ctx.fillStyle = isToday ? "#e9fff3" : "#d5deeb";
    ctx.font = "bold 28px NotoSansBold";
    ctx.fillText(labels[i], x + 18, y + 36);

    const text = item.name || "-";
    ctx.font = `bold ${unifiedNameFontSize}px NotoSansBold`;
    ctx.fillStyle = isFuture ? "#bac3cf" : "#ffffff";
    const subLabelY = y + cardH - 24;
    const nameY = subLabelY - 26;
    ctx.fillText(text, x + 16, nameY);

    if (isPast) {
      if (item.done) {
        ctx.font = "20px NotoSans";
        ctx.fillStyle = "#a9cce1";
        ctx.fillText(payload.tr("daily_canvas_Claimed"), x + 16, subLabelY);
      }
    }

    if (isToday) {
      const todayIsClaimed = !!(payload.todayClaimedNow || item.done);
      ctx.font = "20px NotoSans";
      ctx.fillStyle = todayIsClaimed ? "#a9cce1" : "rgba(220, 255, 236, 0.82)";
      ctx.fillText(
        todayIsClaimed
          ? payload.tr("daily_canvas_Claimed")
          : payload.tr("daily_canvas_CanClaim"),
        x + 16,
        subLabelY,
      );
    }

    if (isFuture) {
      ctx.font = "20px NotoSans";
      ctx.fillStyle = "#8f98a5";
      ctx.fillText(
        i === 2
          ? payload.tr("daily_canvas_AvailableTomorrow")
          : payload.tr("daily_canvas_NotYetAvailable"),
        x + 16,
        subLabelY,
      );
    }

    if (i < items.length - 1) {
      const arrowX = x + cardW + 7;
      const arrowY = timelineY;
      ctx.fillStyle = "rgba(200, 230, 255, 0.64)";
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY - 18);
      ctx.lineTo(arrowX + 14, arrowY);
      ctx.lineTo(arrowX, arrowY + 18);
      ctx.closePath();
      ctx.fill();
    }
  }

  return canvas.toBuffer("image/png");
}
