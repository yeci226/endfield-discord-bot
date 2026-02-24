import {
  createCanvas,
  GlobalFonts,
  CanvasRenderingContext2D,
  loadImage,
  Image,
} from "@napi-rs/canvas";
import path from "path";
import fs from "fs"; // Add this import for fs.readFileSync
import { GachaLeaderboardEntry } from "./gachaLogUtils";
import { fetchImage } from "./canvasUtils";

const star6Path = path.join(__dirname, "../assets/6star.png");
const star5Path = path.join(__dirname, "../assets/5star.png");
const starWhitePath = path.join(__dirname, "../assets/star_white.png");
let cached6Star: Image | null = null;
let cached5Star: Image | null = null;
let cachedStarWhite: Image | null = null;

async function getStarIcons() {
  if (!cached6Star && fs.existsSync(star6Path)) {
    cached6Star = await loadImage(fs.readFileSync(star6Path));
  }
  if (!cached5Star && fs.existsSync(star5Path)) {
    cached5Star = await loadImage(fs.readFileSync(star5Path));
  }
  if (!cachedStarWhite && fs.existsSync(starWhitePath)) {
    cachedStarWhite = await loadImage(fs.readFileSync(starWhitePath));
  }
  return { star6: cached6Star, star5: cached5Star, starWhite: cachedStarWhite };
}

async function fillTextWithStar(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  align: "left" | "center" | "right" = "left",
) {
  const { star6, star5 } = await getStarIcons();
  const parts = text.split(/([★☆])/);

  const iconW = 54;
  const iconH = 29;
  const iconSpacing = 10;

  ctx.font = `${fontSize}px NotoSans`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  let totalWidth = 0;
  if (align !== "left") {
    for (const part of parts) {
      if (part === "★" || part === "☆") {
        totalWidth += iconW + iconSpacing;
      } else if (part) {
        totalWidth += ctx.measureText(part).width;
      }
    }
  }

  let curX = x;
  if (align === "center") curX = x - totalWidth / 2;
  if (align === "right") curX = x - totalWidth;

  const iconY = y - iconH / 2 + 5;

  for (const part of parts) {
    if (part === "★") {
      if (star6) (ctx as any).drawImage(star6, curX, iconY, iconW, iconH);
      curX += iconW + iconSpacing;
    } else if (part === "☆") {
      if (star5) (ctx as any).drawImage(star5, curX, iconY, iconW, iconH);
      curX += iconW + iconSpacing;
    } else if (part) {
      ctx.fillText(part, curX, y);
      curX += ctx.measureText(part).width;
    }
  }
  ctx.textBaseline = "alphabetic";
}

// Register Fonts
const fontDir = path.join(__dirname, "../assets/fonts");
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-400.woff2"),
  "NotoSans",
);
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-700.woff2"),
  "NotoSansTCBold",
);

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill = false,
) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

export async function drawGachaLeaderboard(
  entries: GachaLeaderboardEntry[],
  currentUserId: string,
  poolId: string, // "TOTAL", "SpecialShared", etc.
  sortType: "pulls" | "luck",
  tr: any,
  poolNames: Record<string, string> = {},
): Promise<Buffer> {
  const width = 1170;
  const padding = 60;
  const itemH = 140;
  const headerH = 500;
  const footerPadding = 100;

  // Filter and Sort Entries for this poolId
  const validEntries = entries
    .filter((e) => e.stats[poolId] && e.stats[poolId].total > 0)
    .map((e) => ({
      ...e,
      currentStat: e.stats[poolId],
    }));

  if (sortType === "pulls") {
    validEntries.sort((a, b) => b.currentStat.total - a.currentStat.total);
  } else {
    validEntries.sort(
      (a, b) => b.currentStat.probability - a.currentStat.probability,
    );
  }

  const topUsersCount = 10;
  const topUsers = validEntries.slice(0, topUsersCount);
  const myEntry = validEntries.find((e) => e.uid === currentUserId);
  const myRankIdx = validEntries.findIndex((e) => e.uid === currentUserId);

  // Dynamic Height calculation
  let listCount = topUsers.length;
  if (myEntry && myRankIdx >= topUsersCount) {
    listCount += 1.5; // Space for separator and self rank
  }
  const minHeight = 1143;
  const calculatedHeight = headerH + listCount * itemH + footerPadding;
  const height = Math.max(minHeight, calculatedHeight);

  // Find all displayNames that appear more than once to decide whether to show Account #index
  const nameCounts: Record<string, number> = {};
  validEntries.forEach((e) => {
    if (e.displayName) {
      nameCounts[e.displayName] = (nameCounts[e.displayName] || 0) + 1;
    }
  });

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Load Background
  try {
    const bgPath = path.join(__dirname, "../assets/bg.413ee1.png");
    const bg = await loadImage(fs.readFileSync(bgPath));
    const bgRatio = bg.width / bg.height;
    const canvasRatio = width / height;

    let drawW, drawH, offsetX, offsetY;
    if (bgRatio > canvasRatio) {
      drawH = height;
      drawW = height * bgRatio;
      offsetX = (width - drawW) / 2;
      offsetY = 0;
    } else {
      drawW = width;
      drawH = width / bgRatio;
      offsetX = 0;
      offsetY = (height - drawH) / 2;
    }
    ctx.drawImage(bg, offsetX, offsetY, drawW, drawH);
  } catch (e) {
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, width, height);
  }

  // Dark Overlay
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, width, height);

  // Glassmorphism Header
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const headerPadding = 80;
  ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
  roundRect(
    ctx,
    padding,
    padding,
    width - padding * 2,
    headerH - padding,
    30,
    true,
  );

  // Title
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.fillText(
    tr("gacha_log_leaderboard_Title") || "尋訪紀錄排行榜",
    padding + 50,
    padding + 120,
  );

  // Subtitle (Pool & Sort)
  ctx.font = "32px NotoSans";
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  let poolName = "";
  if (poolId === "TOTAL") poolName = tr("gacha_log_leaderboard_category_TOTAL");
  else if (poolId === "SpecialShared")
    poolName = tr("gacha_log_leaderboard_category_Special");
  else if (poolId === "StandardShared")
    poolName = tr("gacha_log_leaderboard_category_Standard");
  else if (poolId === "WeaponShared")
    poolName = tr("gacha_log_leaderboard_category_Weapon");
  else poolName = poolNames[poolId] || poolId; // Use human-readable name from dict or fallback to ID

  const sortName =
    sortType === "pulls"
      ? tr("gacha_log_leaderboard_sort_pulls")
      : tr("gacha_log_leaderboard_sort_luck");
  const fullSubtitle = `${poolName} | ${sortName}`;
  await fillTextWithStar(
    ctx,
    fullSubtitle,
    padding + 50,
    padding + 180,
    32,
    "rgba(255, 255, 255, 0.6)",
  );

  // Global Stats Box
  const globalTotalPulls = entries.reduce(
    (acc, e) => acc + (e.stats[poolId]?.total || 0),
    0,
  );
  const globalTotalSixCount = entries.reduce(
    (acc, e) => acc + (e.stats[poolId]?.sixStarCount || 0),
    0,
  );
  const avgRate =
    globalTotalPulls > 0
      ? ((globalTotalSixCount / globalTotalPulls) * 100).toFixed(2)
      : "0.00";

  const statBoxSpacing = 25;
  const statBoxW = (width - padding * 2 - 100 - statBoxSpacing * 2) / 3;
  const statBoxY = padding + 240;

  const drawGlobalStat = async (label: string, value: string, x: number) => {
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    roundRect(ctx, x, statBoxY, statBoxW, 140, 20, true);

    await fillTextWithStar(
      ctx,
      label,
      x + statBoxW / 2,
      statBoxY + 45,
      24,
      "rgba(255, 255, 255, 0.5)",
      "center",
    );

    ctx.fillStyle = "#fff";
    ctx.font = "bold 44px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(value, x + statBoxW / 2, statBoxY + 110);
  };

  await drawGlobalStat(
    tr("gacha_log_leaderboard_total_players"),
    String(entries.length),
    padding + 50,
  );
  await drawGlobalStat(
    tr("gacha_log_leaderboard_total_pulls"),
    String(globalTotalPulls),
    padding + 50 + statBoxW + statBoxSpacing,
  );
  await drawGlobalStat(
    tr("gacha_log_leaderboard_avg_rate"),
    `${avgRate}%`,
    padding + 50 + (statBoxW + statBoxSpacing) * 2,
  );

  // Ranking List
  const listY = headerH + 20;
  for (let i = 0; i < topUsers.length; i++) {
    await drawRankItem(
      ctx,
      topUsers[i],
      i + 1,
      padding,
      listY + i * itemH,
      width - padding * 2,
      itemH,
      currentUserId === topUsers[i].uid,
      tr,
      nameCounts,
    );
  }

  // Draw Separator and Self Rank if needed
  if (myEntry && myRankIdx >= topUsersCount) {
    const sepY = listY + topUsers.length * itemH + 40;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.setLineDash([15, 10]);
    ctx.beginPath();
    ctx.moveTo(padding + 50, sepY);
    ctx.lineTo(width - padding - 50, sepY);
    ctx.stroke();
    ctx.setLineDash([]);

    await drawRankItem(
      ctx,
      myEntry,
      myRankIdx + 1,
      padding,
      sepY + 40,
      width - padding * 2,
      itemH,
      true,
      tr,
      nameCounts,
    );
  }

  return canvas.toBuffer("image/png");
}

async function drawRankItem(
  ctx: CanvasRenderingContext2D,
  entry: any,
  rank: number,
  x: number,
  y: number,
  w: number,
  h: number,
  isSelf: boolean,
  tr: any,
  nameCounts: Record<string, number> = {},
) {
  ctx.save();

  // Item Card Background
  ctx.fillStyle = isSelf
    ? "rgba(255, 204, 0, 0.15)"
    : "rgba(255, 255, 255, 0.05)";
  const cardPadding = 10;
  roundRect(ctx, x, y, w, h - cardPadding, 20, true);

  // Rank Display
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const rankX = x + 70;
  const centerY = y + (h - cardPadding) / 2;

  if (rank <= 3) {
    const colors = ["#FFD700", "#C0C0C0", "#CD7F32"];
    ctx.fillStyle = colors[rank - 1];
    ctx.font = "italic bold 60px NotoSansTCBold";
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = "bold 40px NotoSansTCBold";
  }
  ctx.fillText(String(rank), rankX, centerY);

  // Avatar
  const avatarSize = 80;
  const avatarX = x + 150;
  const avatarY = y + (h - cardPadding - avatarSize) / 2;

  ctx.save();
  // Clip to rounded rect without drawing a border
  ctx.beginPath();
  const r = 15;
  ctx.moveTo(avatarX + r, avatarY);
  ctx.arcTo(
    avatarX + avatarSize,
    avatarY,
    avatarX + avatarSize,
    avatarY + avatarSize,
    r,
  );
  ctx.arcTo(
    avatarX + avatarSize,
    avatarY + avatarSize,
    avatarX,
    avatarY + avatarSize,
    r,
  );
  ctx.arcTo(avatarX, avatarY + avatarSize, avatarX, avatarY, r);
  ctx.arcTo(avatarX, avatarY, avatarX + avatarSize, avatarY, r);
  ctx.closePath();
  ctx.clip();
  try {
    let avatarImg: Image | null = null;
    if (entry.avatarUrl) {
      try {
        avatarImg = await fetchImage(entry.avatarUrl);
      } catch (e) {}
    }

    if (!avatarImg) {
      const profilesDir = path.join(__dirname, "../assets/profiles");
      const files = fs
        .readdirSync(profilesDir)
        .filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file));
      if (files.length > 0) {
        const randomFile = files[Math.floor(Math.random() * files.length)];
        const buffer = fs.readFileSync(path.join(profilesDir, randomFile));
        avatarImg = await loadImage(buffer);
      }
    }

    if (avatarImg) {
      const img = avatarImg as Image;
      const imgRatio = img.width / img.height;
      const targetRatio = 1;

      let sx = 0,
        sy = 0,
        sw = img.width,
        sh = img.height;

      if (imgRatio > targetRatio) {
        sw = img.height * targetRatio;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / targetRatio;
        sy = (img.height - sh) / 2;
      }

      (ctx as any).drawImage(
        avatarImg,
        sx,
        sy,
        sw,
        sh,
        avatarX,
        avatarY,
        avatarSize,
        avatarSize,
      );
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    }
  } catch (e) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  }
  ctx.restore();

  // Name and Stats
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px NotoSansTCBold";
  const nameX = avatarX + avatarSize + 30;
  // Discord Display Name (Clean)
  const topLabel = entry.displayName || entry.nickname || "Unknown";

  await fillTextWithStar(
    ctx,
    topLabel,
    nameX,
    centerY - 15,
    36,
    "#fff",
    "left",
  );

  ctx.font = "24px NotoSans";
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";

  // Bottom Label: Prepend (Account #Index) if user has multiple accounts
  const hasMultiple = entry.displayName && nameCounts[entry.displayName] > 1;
  const indexPrefix =
    hasMultiple && entry.accountIndex ? `(#${entry.accountIndex}) ` : "";

  const bottomLabel =
    indexPrefix +
    (entry.gameNickname
      ? tr("gacha_log_canvas_GameNickname", { name: entry.gameNickname })
      : entry.uid && entry.uid.startsWith("EF_GUEST_")
        ? tr("gacha_log_canvas_GuestAccount")
        : entry.nickname || (entry.uid ? `UID: ${entry.uid}` : "Unknown"));

  await fillTextWithStar(
    ctx,
    bottomLabel,
    nameX,
    centerY + 25,
    24,
    "rgba(255, 255, 255, 0.5)",
    "left",
  );

  // Stats Column
  ctx.textAlign = "right";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 40px NotoSansTCBold";
  const statX = x + w - 50;

  // Use Number() to strictly prevent string "null" or literal null
  const totalCount = Number(entry.currentStat?.total || 0);
  const sixStarCount = Number(entry.currentStat?.sixStarCount || 0);
  const fiveStarCount = Number(entry.currentStat?.fiveStarCount || 0);
  const probability = Number(entry.currentStat?.probability || 0);
  const probStr = (probability * 100).toFixed(2) + "%";

  ctx.fillText(probStr, statX, centerY);

  // Stat row rendering
  {
    const { starWhite } = await getStarIcons();
    const iconW = 22;
    const iconH = 22;
    const iconSpacing = 5; // between number and icon
    const groupSpacing = 40; // between groups
    const fontSize = 24;
    const iconY = centerY + 25 - iconH / 2 + 2.5;

    ctx.font = `bold ${fontSize}px NotoSans`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const segPulls = `${totalCount}${tr("gacha_log_canvas_Pulls_Suffix")}`;
    const seg6Num = `6`;
    const seg6Count = `x${sixStarCount}`;
    const seg5Num = `5`;
    const seg5Count = `x${fiveStarCount}`;

    const wPulls = ctx.measureText(segPulls).width;
    const w6Num = ctx.measureText(seg6Num).width;
    const w6Count = ctx.measureText(seg6Count).width;
    const w5Num = ctx.measureText(seg5Num).width;
    const w5Count = ctx.measureText(seg5Count).width;

    const totalW =
      wPulls +
      groupSpacing +
      w6Num +
      iconSpacing +
      iconW +
      iconSpacing + // 6 + star + gap
      w6Count +
      groupSpacing +
      w5Num +
      iconSpacing +
      iconW +
      iconSpacing + // 5 + star + gap
      w5Count;

    let curX = statX - totalW;

    // [#e0e0e0] 317抽
    ctx.fillStyle = "#e0e0e0";
    ctx.fillText(segPulls, curX, centerY + 25);
    curX += wPulls + groupSpacing;

    // [#e0e0e0] 6 + star_white
    ctx.fillStyle = "#f97316";
    ctx.fillText(seg6Num, curX, centerY + 25);
    curX += w6Num + iconSpacing;
    if (starWhite) (ctx as any).drawImage(starWhite, curX, iconY, iconW, iconH);
    curX += iconW + iconSpacing;

    // [#ffffff] x0 (six star count)
    ctx.fillStyle = "#ffffff";
    ctx.fillText(seg6Count, curX + 5, centerY + 25);
    curX += w6Count + groupSpacing;

    // [#facc15] 5 + star_white
    ctx.fillStyle = "#facc15";
    ctx.fillText(seg5Num, curX, centerY + 25);
    curX += w5Num + iconSpacing;
    if (starWhite) (ctx as any).drawImage(starWhite, curX, iconY, iconW, iconH);
    curX += iconW + iconSpacing;

    // [#ffffff] x0 (five star count)
    ctx.fillStyle = "#ffffff";
    ctx.fillText(seg5Count, curX + 5, centerY + 25);

    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();
}
