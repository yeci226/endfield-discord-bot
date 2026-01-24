import {
  createCanvas,
  loadImage,
  GlobalFonts,
  CanvasRenderingContext2D,
  Image,
} from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import axios from "axios";
import { CardDetail } from "./skportApi";
import moment from "moment";
import crypto from "crypto";

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

const ASSETS_DIR = path.join(__dirname, "../assets");
const CACHE_DIR = path.join(ASSETS_DIR, "remote_cache");

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const imageCache = new Map<string, Image>();

export async function drawDashboard(detail: CardDetail): Promise<Buffer> {
  const { base, chars } = detail;

  // Canvas dimensions (2400x1600)
  // Canvas dimensions
  const width = 2400;
  const padding = 80;

  // Calculate required height based on characters
  const charCols = 10;
  const charGap = 15;
  // Calculate char dimensions (replicated from logic below)
  const charWidth = (width - padding * 2 - (charCols - 1) * charGap) / charCols;
  const charImageSize = charWidth;
  const charHeight = charImageSize + 60;

  // Header ends roughly at padding + 150 + something?
  // Grid Y was 320.
  // Realtime Y was GridY + 180 (500).
  // SectionH is 260.
  // Char Title at RealTimeY + SectionH + 150 = 500 + 260 + 150 = 910.
  // Char Grid Starts at Char Grid Y = RealTimeY + SectionH + 180 = 500 + 260 + 180 = 940.
  // Char Grid Starts at Char Grid Y
  // GridY(320) + Mission(160) + Gap(50) + RealTime(180) + Gap(100) + Title(50) + Gap = ~1020
  const charGridY = 1020;
  const rows = Math.ceil(chars.length / charCols);
  const requiredCharGridHeight = rows * (charHeight + charGap);

  // Base height was 1600.
  let height = 1600;
  if (charGridY + requiredCharGridHeight + padding > height) {
    height = charGridY + requiredCharGridHeight + padding;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Helper for local image loading
  const loadLocalImage = async (relPath: string) => {
    if (imageCache.has(relPath)) {
      return imageCache.get(relPath)!;
    }
    try {
      const fullPath = path.join(ASSETS_DIR, relPath);
      const img = await loadImage(fs.readFileSync(fullPath));
      imageCache.set(relPath, img);
      return img;
    } catch (e) {
      throw e;
    }
  };

  // 1. Background
  try {
    const bg = await loadLocalImage("bg.08c7f0.png");

    // Draw background with 'cover' logic
    const bgRatio = bg.width / bg.height;
    const canvasRatio = width / height;

    let drawW, drawH, offsetX, offsetY;

    if (bgRatio > canvasRatio) {
      // Background is relatively wider -> match height
      drawH = height;
      drawW = height * bgRatio;
      offsetX = (width - drawW) / 2;
      offsetY = 0;
    } else {
      // Background is relatively taller -> match width
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

  // Overlay
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, width, height);

  // Header (Avatar + Info) - Shrunk

  const avatarSize = 180;

  // Draw Avatar
  ctx.save();
  roundRect(ctx, padding, padding, avatarSize, avatarSize, 30);
  ctx.clip();
  if (base.avatarUrl) {
    try {
      const avatarImg = await fetchImage(base.avatarUrl);
      ctx.drawImage(avatarImg, padding, padding, avatarSize, avatarSize);
    } catch (e) {
      ctx.fillStyle = "#333";
      ctx.fillRect(padding, padding, avatarSize, avatarSize);
    }
  }
  ctx.restore();

  // Name & Stats
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.fillText(base.name, padding + avatarSize + 40, padding + 90);

  ctx.font = "36px NotoSans";
  ctx.fillStyle = "#aaaaaa";
  const awakeDate = moment(parseInt(base.createTime) * 1000).format(
    "YYYY/MM/DD",
  );
  const lastLoginTime = moment(parseInt(base.lastLoginTime) * 1000).format(
    "YYYY/MM/DD",
  );
  ctx.fillText(
    `UID ${base.roleId} | 甦醒日 ${awakeDate} | 最後登入 ${lastLoginTime} | ${base.serverName}`,
    padding + avatarSize + 40,
    padding + 150,
  );

  // 3. Stats Grid - Shrunk
  const gridY = 320;
  const itemW = (width - padding * 2 - 90) / 4;
  const itemH = 140;
  const gap = 30;

  const stats = [
    { label: "探索等級", value: base.worldLevel.toString() },
    { label: "幹員", value: base.charNum.toString() },
    { label: "武器", value: base.weaponNum.toString() },
    { label: "檔案", value: base.docNum.toString() },
  ];

  stats.forEach((stat, i) => {
    const x = padding + (itemW + gap) * i;
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, x, gridY, itemW, itemH, 20, true);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 56px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(stat.value, x + itemW / 2, gridY + 65);

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "28px NotoSans";
    ctx.fillText(stat.label, x + itemW / 2, gridY + 110);
  });

  // Reset textAlign
  ctx.textAlign = "left";

  // 3.5. Mission & Level (New Row)
  const mlY = gridY + 160;
  const mlH = 160;

  // Mission Box (Left, 70%)
  const missionW = (width - padding * 2) * 0.7 - 10;
  ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
  roundRect(ctx, padding, mlY, missionW, mlH, 20, true);

  if (base.mainMission) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 60px NotoSansTCBold";
    ctx.textAlign = "left";
    ctx.fillText(base.mainMission.description, padding + 40, mlY + 70);

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "32px NotoSans";
    ctx.fillText("使命記事", padding + 40, mlY + 120);
  }

  // Level Box (Right, 30%)
  const levelX = padding + missionW + 20;
  const levelW = width - padding * 2 - missionW - 20;
  ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
  roundRect(ctx, levelX, mlY, levelW, mlH, 20, true);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.textAlign = "center";
  ctx.fillText(base.level.toString(), levelX + levelW / 2, mlY + 80);

  ctx.fillStyle = "#aaaaaa";
  ctx.font = "32px NotoSans";
  ctx.fillText("權限等級", levelX + levelW / 2, mlY + 130);
  ctx.textAlign = "left"; // Reset

  // 4. Real-time Data (即時數據) - Compact
  const realTimeY = mlY + mlH + 30; // Reduced gap from 50 to 30
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 50px NotoSansTCBold";
  ctx.fillText("即時數據", padding + 70, realTimeY + 40);
  ctx.fillRect(padding, realTimeY + 10, 12, 35);
  ctx.fillRect(padding + 20, realTimeY - 5, 12, 50);
  ctx.fillRect(padding + 40, realTimeY + 15, 12, 25);

  const sectionH = 180; // Reduced height
  const leftW = 750;
  const rightW = width - padding * 2 - leftW - 40;

  // Left Section: Stamina
  ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
  roundRect(ctx, padding, realTimeY + 80, leftW, sectionH, 20, true);

  const { dungeon, dailyMission, bpSystem } = detail;

  if (dungeon) {
    ctx.textAlign = "left";

    // Value: 37 / 205
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 70px NotoSansTCBold";
    const curStamina = dungeon.curStamina;
    ctx.fillText(curStamina, padding + 40, realTimeY + 160);
    const curWidth = ctx.measureText(curStamina).width;

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "36px NotoSans";
    ctx.fillText(
      `/ ${dungeon.maxStamina}`,
      padding + 40 + curWidth + 15,
      realTimeY + 160,
    );

    // Recovery Time (Pill with Background)
    const now = Math.floor(Date.now() / 1000);
    const maxTs = parseInt(dungeon.maxTs);
    let recoveryText = "已完全恢復";
    let diff = 0;
    if (
      maxTs > now &&
      parseInt(dungeon.curStamina) < parseInt(dungeon.maxStamina)
    ) {
      diff = maxTs - now;
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      recoveryText = `${h}小時${m}分鐘`;
    }

    // Dynamic Color for Dot
    const maxRecoverySec = (parseInt(dungeon.maxStamina) / 10) * 60 * 60;
    const ratio = Math.min(diff / maxRecoverySec, 1);
    const hue = 120 * (1 - ratio);
    const dotColor = `hsl(${hue}, 100%, 50%)`;

    // Calculate dimensions
    ctx.font = "30px NotoSans"; // Increased
    const recTextW = ctx.measureText(recoveryText).width;
    const dotR = 8; // Increased
    const dotGap = 12; // Increased
    const pillPaddingX = 20; // Increased
    const pillPaddingY = 12; // Increased
    const pillW = pillPaddingX * 2 + dotR * 2 + dotGap + recTextW;
    const pillH = 30 + pillPaddingY * 2; // Approx text height 30

    const pillX = padding + leftW - pillW - 30; // Right aligned with padding
    const pillY = realTimeY + 110;

    // Draw Pill Background
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)"; // Darker background for contrast
    roundRect(ctx, pillX, pillY, pillW, pillH, 20, true);

    // Draw Dot
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    const dotX = pillX + pillPaddingX + dotR;
    const dotY = pillY + pillH / 2;
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();

    // Draw Text
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    // Center text vertically
    ctx.fillText(recoveryText, dotX + dotR + dotGap, pillY + pillH / 2 + 11);

    // Label
    ctx.textAlign = "left";
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "24px NotoSans";
    const labelY = realTimeY + 210;
    ctx.fillText("理智", padding + 40, labelY);
    ctx.textAlign = "right";
    ctx.fillText("恢復時間", padding + leftW - 30, labelY); // Align with pill right
    ctx.textAlign = "left";
  }

  // Right Section: Activity & Pass
  ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
  roundRect(
    ctx,
    padding + leftW + 40,
    realTimeY + 80,
    rightW,
    sectionH,
    20,
    true,
  );

  const rightItemCenterY = realTimeY + 80 + sectionH / 2;
  // Split right section into two vertical halves visually? Or just stack?
  // Original was stack. We reduced height, so maybe side-by-side or tighter stack.
  // With 180px height, stacking 2 items with 40px text is tight.
  // Let's do side-by-side for Activity and BP within the right box.

  const halfRightW = rightW / 2;

  if (dailyMission) {
    const actX = padding + leftW + 40;
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 56px NotoSansTCBold";
    ctx.fillText(
      `${dailyMission.dailyActivation}/${dailyMission.maxDailyActivation}`,
      actX + halfRightW / 2,
      rightItemCenterY + 10,
    );
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "28px NotoSans";
    ctx.fillText("活躍度", actX + halfRightW / 2, rightItemCenterY + 55);
  }

  if (bpSystem) {
    const bpX = padding + leftW + 40 + halfRightW;
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 56px NotoSansTCBold";
    ctx.fillText(
      `${bpSystem.curLevel}/${bpSystem.maxLevel}`,
      bpX + halfRightW / 2,
      rightItemCenterY + 10,
    );
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "28px NotoSans";
    ctx.fillText("通行證等級", bpX + halfRightW / 2, rightItemCenterY + 55);
  }

  // 5. Characters Title
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 50px NotoSansTCBold";
  ctx.fillText("幹員", padding, realTimeY + sectionH + 140);

  // 6. Characters List (Grid)

  const charAssetsPromises = chars.map(async (char) => {
    const iconUrl = char.charData.avatarSqUrl || char.charData.avatarRtUrl;
    if (iconUrl) {
      // fetchImage now handles disk/memory caching automatically
      fetchImage(iconUrl).catch(() => {});
    }

    const profKey = char.charData.profession?.key;
    if (profKey) {
      const strippedKey = profKey.replace("profession_", "").toLowerCase();
      loadLocalImage(`prof/${strippedKey}.jpg`).catch(() => {});
    }

    const propKey = char.charData.property?.key;
    if (propKey) {
      const strippedKey = propKey.replace("char_property_", "").toLowerCase();
      loadLocalImage(`element/${strippedKey}.jpg`).catch(() => {});
    }

    const weaponKey = char.charData.weaponType?.key;
    if (weaponKey) {
      const strippedKey = weaponKey.replace("weapon_type_", "").toLowerCase();
      loadLocalImage(`weapon/black/${strippedKey}.png`).catch(() => {});
    }

    if (char.evolvePhase !== undefined) {
      loadLocalImage(`phase/${char.evolvePhase}.webp`).catch(() => {});
    }
  });

  await Promise.all(charAssetsPromises);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const row = Math.floor(i / charCols);
    const col = i % charCols;
    const x = padding + (charWidth + charGap) * col;
    const y = charGridY + (charHeight + charGap) * row;

    if (y + charHeight > height) break;

    // Load images (fast from cache)
    const iconUrl = char.charData.avatarSqUrl || char.charData.avatarRtUrl;
    let avatarImg: Image | null = null;
    try {
      avatarImg = iconUrl ? await fetchImage(iconUrl) : null;
    } catch (e) {}

    let profImg: Image | null = null;
    let propImg: Image | null = null;
    let weaponImg: Image | null = null;
    let phaseImg: Image | null = null;

    try {
      const profKey = char.charData.profession?.key;
      if (profKey) {
        profImg = await loadLocalImage(
          `prof/${profKey.replace("profession_", "").toLowerCase()}.jpg`,
        );
      }
    } catch (e) {}

    try {
      const propKey = char.charData.property?.key;
      if (propKey) {
        propImg = await loadLocalImage(
          `element/${propKey.replace("char_property_", "").toLowerCase()}.jpg`,
        );
      }
    } catch (e) {}

    try {
      const weaponKey = char.charData.weaponType?.key;
      if (weaponKey) {
        weaponImg = await loadLocalImage(
          `weapon/black/${weaponKey.replace("weapon_type_", "").toLowerCase()}.png`,
        );
      }
    } catch (e) {}

    try {
      if (char.evolvePhase !== undefined) {
        phaseImg = await loadLocalImage(`phase/${char.evolvePhase}.webp`);
      }
    } catch (e) {}

    // Image Area with White Background (Top rounded, Bottom square)
    ctx.save();
    const radius = 15;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + charImageSize - radius, y);
    ctx.arcTo(x + charImageSize, y, x + charImageSize, y + radius, radius);
    ctx.lineTo(x + charImageSize, y + charImageSize); // Bottom right square
    ctx.lineTo(x, y + charImageSize); // Bottom left square
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();

    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.clip();

    if (avatarImg) {
      ctx.drawImage(avatarImg, x, y, charImageSize, charImageSize);
    } else {
      ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
      ctx.fillRect(x, y, charImageSize, charImageSize);
    }
    ctx.restore();

    // Attribute Icons (Top Left, Vertical) - Shrunk
    const iconSize = 36;
    const iconPadding = 8;

    // Profession Icon
    if (profImg) {
      const iconY = y + iconPadding;
      ctx.drawImage(profImg, x + iconPadding, iconY, iconSize, iconSize);
    }

    // Element/Property Icon
    if (propImg) {
      const iconY = y + iconPadding + iconSize + iconPadding;
      ctx.drawImage(propImg, x + iconPadding, iconY, iconSize, iconSize);
    }

    // Weapon Type Icon
    if (weaponImg) {
      const iconY = y + iconPadding + (iconSize + iconPadding) * 2;
      ctx.drawImage(weaponImg, x + iconPadding, iconY, iconSize, iconSize);
    }

    // Level (Bottom Left)
    ctx.textAlign = "left";
    ctx.font = "bold 28px NotoSansTCBold";
    const levelText = `${char.level}`;

    // Stroke settings
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";

    // Draw "Lv."
    ctx.font = "18px NotoSans";
    ctx.strokeText("Lv.", x + 10, y + charImageSize - 18);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Lv.", x + 10, y + charImageSize - 18);
    const lvPrefixWidth = ctx.measureText("Lv.").width;

    // Draw Level Number
    ctx.font = "bold 28px NotoSansTCBold";
    ctx.strokeText(
      levelText,
      x + 10 + lvPrefixWidth + 2,
      y + charImageSize - 18,
    );
    ctx.fillText(levelText, x + 10 + lvPrefixWidth + 2, y + charImageSize - 18);

    // Phase (Bottom Right)
    if (phaseImg) {
      const phaseSize = 24;
      const phaseX = x + charImageSize - 45;
      const phaseY = y + charImageSize - 35;

      ctx.drawImage(phaseImg, phaseX, phaseY, phaseSize, phaseSize);

      ctx.textAlign = "left";
      ctx.font = "bold 24px NotoSans";
      ctx.strokeText(
        `${char.evolvePhase}`,
        phaseX + phaseSize + 5,
        phaseY + 22,
      );
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${char.evolvePhase}`, phaseX + phaseSize + 5, phaseY + 22);
    }

    // Rarity Color Bar
    const getRarityColor = (r: number) => {
      switch (r) {
        case 6:
          return "rgba(255, 113, 0, 1)";
        case 5:
          return "rgba(255, 204, 0, 1)";
        case 4:
          return "rgba(179, 128, 255, 1)";
        case 3:
          return "rgba(51, 194, 255, 1)";
        case 2:
          return "rgba(180, 217, 69, 1)";
        case 1:
          return "rgba(178, 178, 178, 1)";
        default:
          return "rgba(178, 178, 178, 1)";
      }
    };

    const rarity = parseInt(char.charData.rarity?.value) || 0;
    ctx.fillStyle = getRarityColor(rarity);
    ctx.fillRect(x, y + charImageSize - 6, charImageSize, 6);

    // Name
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px NotoSansTCBold";
    ctx.fillText(char.charData.name, x + charWidth / 2, y + charImageSize + 35);
  }

  return canvas.toBuffer("image/png");
}

async function fetchImage(url: string): Promise<Image> {
  if (imageCache.has(url)) return imageCache.get(url)!;

  const urlHash = crypto.createHash("md5").update(url).digest("hex");
  const ext = url.split(".").pop()?.split(/[?#]/)[0] || "png";
  const cachePath = path.join(CACHE_DIR, `${urlHash}.${ext}`);

  // 1. Check disk cache
  if (fs.existsSync(cachePath)) {
    try {
      const img = await loadImage(fs.readFileSync(cachePath));
      imageCache.set(url, img);
      return img;
    } catch (e) {
      // If corruption occurs, delete and re-fetch
      fs.unlinkSync(cachePath);
    }
  }

  // 2. Fetch remote
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);

    // Save to disk cache
    fs.writeFileSync(cachePath, buffer);

    const img = await loadImage(buffer);
    imageCache.set(url, img);
    return img;
  } catch (e) {
    console.error(`Failed to fetch image: ${url}`, e);
    throw e;
  }
}

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
function parseEffectString(effectStr: string, params: any): string {
  if (!effectStr) return "";
  let res = effectStr;
  // Strip tags like <@ba.vup> or </>
  res = res.replace(/<[^>]+>/g, "");
  // Replace {key:0} or {key}
  res = res.replace(/\{(\w+)(?::\d+%?)?\}/g, (match, key) => {
    let val = params[key];
    if (val === undefined) return match;
    // Basic percentage handling if requested in placeholder
    if (match.includes("%") && !isNaN(Number(val))) {
      return (Number(val) * 100).toFixed(0) + "%";
    }
    return val;
  });
  res = res
    .replace(/，/g, ", ")
    .replace(/。/g, ". ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "?")
    .replace(/！/g, "!");
  return res;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxHeight: number = 0,
) {
  const paragraphs = text.split("\n");
  let testY = y;

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    const chars = para.split("");
    let line = "";

    for (let n = 0; n < chars.length; n++) {
      let testLine = line + chars[n];
      let metrics = ctx.measureText(testLine);
      let testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        if (maxHeight > 0 && testY + lineHeight - y > maxHeight) {
          ctx.fillText(line.substring(0, line.length - 1) + "...", x, testY);
          return testY;
        }
        ctx.fillText(line, x, testY);
        line = chars[n];
        testY += lineHeight;
      } else {
        line = testLine;
      }
    }

    if (maxHeight > 0 && testY + lineHeight - y > maxHeight) {
      ctx.fillText(line.substring(0, line.length - 1) + "...", x, testY);
      return testY;
    }

    ctx.fillText(line, x, testY);
    testY += lineHeight;
  }
  return testY;
}

export async function drawCharacterDetail(
  char: any,
  enums: any[] = [],
  charIndex: number = 1,
): Promise<Buffer> {
  const width = 2400;
  const height = 1400; // Increased height
  const leftW = 720;
  const padding = 60;
  const rightX = leftW + 60;
  const rightW = width - rightX - padding;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const imgUrl =
    char.charData.illustrationUrl ||
    char.charData.avatarRtUrl ||
    char.charData.avatarSqUrl;

  const loadLocalImage = async (relPath: string) => {
    if (imageCache.has(relPath)) return imageCache.get(relPath)!;
    try {
      const fullPath = path.join(ASSETS_DIR, relPath);
      const img = await loadImage(fs.readFileSync(fullPath));
      imageCache.set(relPath, img);
      return img;
    } catch (e) {
      throw e;
    }
  };

  const starImg = await loadLocalImage("star.png");

  // --- PRE-LOAD ALL ASSETS IN PARALLEL ---
  const skillUrls = (char.charData.skills || [])
    .map((s: any) => s.iconUrl)
    .filter(Boolean);
  const equipUrls: string[] = [
    char.bodyEquip?.equipData?.iconUrl,
    char.armEquip?.equipData?.iconUrl,
    char.firstAccessory?.equipData?.iconUrl,
    char.secondAccessory?.equipData?.iconUrl,
    char.tacticalItem?.tacticalItemData?.iconUrl,
  ].filter(Boolean);

  const weaponUrl = char.weapon?.weaponData?.iconUrl;
  const gemUrl = char.weapon?.gem?.iconUrl || char.weapon?.gem?.icon;

  const remoteUrls = [
    imgUrl,
    ...skillUrls,
    ...equipUrls,
    weaponUrl,
    gemUrl,
  ].filter((url) => url && url.startsWith("http"));

  const localAssets = [
    char.charData.profession?.key
      ? `prof/${char.charData.profession.key.replace("profession_", "").toLowerCase()}.jpg`
      : null,
    char.charData.property?.key
      ? `element/${char.charData.property.key.replace("char_property_", "").toLowerCase()}.jpg`
      : null,
    char.weapon?.weaponData?.type?.key
      ? `weapon/black/${char.weapon.weaponData.type.key.replace("weapon_type_", "").toLowerCase()}.png`
      : null,
    char.evolvePhase !== undefined ? `phase/${char.evolvePhase}.webp` : null,
    char.potentialLevel > 0 ? `rank/${char.potentialLevel}.png` : null,
    char.weapon?.breakthroughLevel > 0
      ? `rank/${char.weapon.breakthroughLevel}.png`
      : null,
  ].filter(Boolean) as string[];

  // Trigger parallel loading
  await Promise.all([
    ...remoteUrls.map((url) => fetchImage(url)),
    ...localAssets.map((path) => loadLocalImage(path)),
  ]);

  // 1. Backgrounds
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#d8d8d8";
  ctx.fillRect(0, 0, leftW, height);

  // Branding Polygon (Behind character)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(leftW, 0);
  ctx.lineTo(leftW, 550);
  ctx.lineTo(leftW - 350, 0);
  ctx.closePath();
  ctx.fillStyle = "#ffcc00"; // Endfield Yellow
  ctx.fill();
  ctx.restore();

  // 2. Character Art
  // Clip to leftW to prevent overflow
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, leftW, height);
  ctx.clip();

  if (imgUrl) {
    try {
      const img = await fetchImage(imgUrl);
      const ratio = img.width / img.height;
      let drawH = height;
      let drawW = height * ratio;
      const x = (leftW - drawW) / 2;
      ctx.drawImage(img, x, 0, drawW, drawH);
    } catch (e) {}
  }
  ctx.restore();

  // Vertical Branding Text (On top of character art)
  ctx.save();
  ctx.translate(leftW - 25, 40);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.letterSpacing = "4px";
  ctx.fillText(
    `ENDFIELD INDUSTRIES — ${charIndex.toString().padStart(2, "0")}`,
    0,
    0,
  );
  ctx.restore();

  const grad = ctx.createLinearGradient(0, height - 350, 0, height);
  grad.addColorStop(0, "rgba(216, 216, 216, 0)");
  grad.addColorStop(1, "rgba(216, 216, 216, 1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, height - 350, leftW, 350);

  // 3. Left Panel Info Redesign (v7)
  const infoY = height - 420;

  // Row 1: Name + Stars
  ctx.fillStyle = "#000000";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.fillText(`${char.charData.name}`, padding, infoY + 60);

  const charRarity = parseInt(char.charData.rarity?.value) || 0;
  const charStarS = 40;
  for (let i = 0; i < charRarity; i++) {
    ctx.drawImage(
      starImg,
      padding + i * (charStarS + 8),
      infoY + 80,
      charStarS,
      charStarS,
    );
  }

  // Row 2: Icons
  const row2Y = infoY + 160;
  const iconS = 80;
  const iconG = 25;
  let row2X = padding;

  // Profession Icon
  const profKey = char.charData.profession?.key;
  if (profKey) {
    try {
      const img = await loadLocalImage(
        `prof/${profKey.replace("profession_", "").toLowerCase()}.jpg`,
      );
      ctx.drawImage(img, row2X, row2Y, iconS, iconS);
      row2X += iconS + iconG;
    } catch (e) {}
  }

  // Property Icon
  const propKey = char.charData.property?.key;
  if (propKey) {
    try {
      const img = await loadLocalImage(
        `element/${propKey.replace("char_property_", "").toLowerCase()}.jpg`,
      );
      ctx.drawImage(img, row2X, row2Y, iconS, iconS);
      row2X += iconS + iconG;
    } catch (e) {}
  }

  // Level display in the corner of image area
  const numText = `${char.level}`;
  const labelText = "LEVEL";

  ctx.font = "bold 90px NotoSansTCBold";
  const numW = ctx.measureText(numText).width;
  ctx.font = "bold 44px NotoSansTCBold";
  const labelW = ctx.measureText(labelText).width;

  const totalW = numW + labelW + 10;
  const startX = leftW - totalW - 20;

  ctx.fillStyle = "#111";
  ctx.font = "bold 90px NotoSansTCBold";
  ctx.fillText(numText, startX, infoY + 70);
  ctx.font = "44px NotoSans";
  ctx.fillText(labelText, startX + numW + 10, infoY + 70);

  // Row 3: Tags
  const row3Y = row2Y + iconS + 20;
  const tags = char.charData.tags || [];
  let tagX = padding;
  tags.forEach((tag: string) => {
    ctx.font = "bold 26px NotoSansTCBold";
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = "rgba(0,0,0,0.1)";
    roundRect(ctx, tagX, row3Y, tw + 24, 45, 10, true);
    ctx.fillStyle = "#444";
    ctx.fillText(tag, tagX + 12, row3Y + 32);
    tagX += tw + 40;
  });

  if (char.ownTs) {
    const ownDate = moment(parseInt(char.ownTs) * 1000).format("YYYY/MM/DD");
    ctx.fillStyle = "#888";
    ctx.font = "24px NotoSans";
    ctx.fillText(`結識時間 ${ownDate}`, padding - 40, height - 20);
  }

  // --- RIGHT SECTION ---
  const skillsY = 80;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 技能", rightX, skillsY);

  const skY = skillsY + 20,
    skSize = 130;
  const skList = char.charData.skills || [];
  for (let i = 0; i < 4; i++) {
    const s = skList[i],
      sx = rightX + i * (skSize + 110);
    ctx.fillStyle = "#cccccc";
    ctx.beginPath();
    ctx.arc(sx + skSize / 2, skY + skSize / 2 + 20, skSize / 2, 0, Math.PI * 2);
    ctx.fill();
    if (s && s.iconUrl) {
      try {
        const sImg = await fetchImage(s.iconUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(
          sx + skSize / 2,
          skY + skSize / 2 + 20,
          skSize / 2 - 3,
          0,
          Math.PI * 2,
        );
        ctx.clip();
        ctx.drawImage(sImg, sx, skY + 20, skSize, skSize);
        ctx.restore();
      } catch (e) {}
    }
    // Dynamic Skill Rank & Level (Now on top)
    const userSk = char.userSkills?.[s?.id || ""] || { level: 1, maxLevel: 1 };
    const rankLabel = "RANK";
    const levelNum = `${userSk.level}`;
    const maxLevel = `/${userSk.maxLevel}`;

    ctx.font = "bold 18px NotoSans";
    const rankW = ctx.measureText(rankLabel).width;
    ctx.font = "bold 26px NotoSans";
    const levelW = ctx.measureText(levelNum).width;
    ctx.font = "16px NotoSans";
    const maxW = ctx.measureText(maxLevel).width;

    const totalW = rankW + levelW + maxW + 15;
    const infoX = sx + skSize / 2 - totalW / 2;
    const infoY = skY + skSize + 45;

    // Rank Label (Gray)
    ctx.textAlign = "left";
    ctx.font = "bold 18px NotoSans";
    ctx.fillStyle = "#888";
    ctx.fillText(rankLabel, infoX, infoY + 2);

    // Level Num (Dark)
    ctx.font = "bold 26px NotoSans";
    ctx.fillStyle = "#111";
    ctx.fillText(levelNum, infoX + rankW + 10, infoY + 2);

    // Max Level (Gray)
    ctx.font = "16px NotoSans";
    ctx.fillStyle = "#888";
    ctx.fillText(maxLevel, infoX + rankW + levelW + 15, infoY + 2);

    // Skill Name (Now at bottom)
    ctx.fillStyle = "#222";
    ctx.font = "bold 28px NotoSansTCBold";
    ctx.textAlign = "center";
    const skName = (s?.name || "未知")
      .replace(/，/g, ", ")
      .replace(/。/g, ". ")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/？/g, "?")
      .replace(/！/g, "!");
    ctx.fillText(skName, sx + skSize / 2, skY + skSize + 80);
  }
  ctx.textAlign = "left";

  const getRarityColor = (rKey: string) => {
    if (rKey.includes("_6")) return "rgba(255, 113, 0, 1)"; // Orange
    if (rKey.includes("_5")) return "rgba(255, 204, 0, 1)"; // Yellow
    if (rKey.includes("_4")) return "rgba(179, 128, 255, 1)"; // Purple
    if (rKey.includes("_3")) return "rgba(51, 194, 255, 1)"; // Blue
    if (rKey.includes("_2")) return "rgba(180, 217, 69, 1)"; // Green
    if (rKey.includes("_1")) return "rgba(178, 178, 178, 1)"; // Gray
    return "rgba(178, 178, 178, 1)";
  };

  const drawPlaceholder = (x: number, y: number, w: number, h: number) => {
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 10]);
    ctx.strokeRect(x + 20, y + 20, w - 40, h - 40);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - 40, y + h / 2 - 40);
    ctx.lineTo(x + w / 2 + 40, y + h / 2 + 40);
    ctx.moveTo(x + w / 2 + 40, y + h / 2 - 40);
    ctx.lineTo(x + w / 2 - 40, y + h / 2 + 40);
    ctx.stroke();
  };

  const weaponTitleY = 380;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 武器", rightX, weaponTitleY);

  const eGap = 20;
  const wCardW = (rightW - eGap) * 0.66;
  const wSlotW = rightW - wCardW - eGap;
  const wCardH = 180;
  const wCardY = weaponTitleY + 30;

  // Weapon Card
  ctx.fillStyle = "#fcfcfc";
  ctx.shadowColor = "rgba(0,0,0,0.05)";
  ctx.shadowBlur = 10;
  roundRect(ctx, rightX, wCardY, wCardW, wCardH, 15, true);
  ctx.shadowBlur = 0;

  if (char.weapon) {
    const wd = char.weapon.weaponData;
    const rKey = wd.rarity?.key || "";
    ctx.fillStyle = getRarityColor(rKey);
    ctx.fillRect(rightX, wCardY, 15, wCardH);

    ctx.fillStyle = "#111";
    ctx.font = "bold 50px NotoSansTCBold";
    ctx.fillText(`${char.weapon.level}`, rightX + 45, wCardY + 70);
    const wLvW = ctx.measureText(`${char.weapon.level}`).width;
    ctx.font = "20px NotoSans";
    ctx.fillText("LEVEL", rightX + 45 + wLvW + 10, wCardY + 70);
    const wLabelW = ctx.measureText("LEVEL").width;

    const wRarity = parseInt(rKey.split("_").pop() || "0");
    for (let j = 0; j < wRarity; j++) {
      ctx.drawImage(starImg, rightX + 45 + j * 30, wCardY + 85, 25, 25);
    }

    ctx.fillStyle = "#111";
    ctx.font = "bold 32px NotoSansTCBold";
    ctx.fillText(wd.name || "Unknown", rightX + 45, wCardY + 160);

    if (wd.iconUrl) {
      try {
        const wImg = await fetchImage(wd.iconUrl);
        ctx.save();
        ctx.translate(rightX + wCardW - 120, wCardY + 90);
        ctx.rotate(-Math.PI / 15);
        ctx.drawImage(wImg, -100, -100, 200, 200);
        ctx.restore();
      } catch (e) {}
    }
  }

  // Weapon Section Slot (Gem/Plugin)
  ctx.fillStyle = "#fcfcfc";
  ctx.shadowColor = "rgba(0,0,0,0.05)";
  ctx.shadowBlur = 10;
  const slotX = rightX + wCardW + eGap;
  roundRect(ctx, slotX, wCardY, wSlotW, wCardH, 15, true);
  ctx.shadowBlur = 0;

  let hasGem = false;
  const gemData = char.weapon?.gem;
  if (gemData) {
    const gIcon = gemData.iconUrl || gemData.icon;
    if (gIcon) {
      try {
        const gImg = gIcon.startsWith("http")
          ? await fetchImage(gIcon)
          : await loadLocalImage(gIcon);
        ctx.drawImage(gImg, slotX + 15, wCardY + 15, wSlotW - 30, wCardH - 30);
        hasGem = true;
      } catch (e) {}
    }
  }

  if (!hasGem) {
    drawPlaceholder(slotX, wCardY, wSlotW, wCardH);
  }

  // 6. Configuration Grid (2:3)
  const gridTitleY = wCardY + wCardH + 50;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 裝配配置", rightX, gridTitleY);

  const egX = rightX;
  const egY = gridTitleY + 30;
  const totalGridH = height - egY - 60;
  const colW1 = (rightW - eGap) / 2;
  const colW2 = colW1;
  const itemH_L = (totalGridH - eGap) / 2;
  const itemH_R = (totalGridH - 2 * eGap) / 3;

  const leftItems = [
    { item: char.bodyEquip, type: "護甲" },
    { item: char.armEquip, type: "護手" },
  ];
  const rightItems = [
    { item: char.firstAccessory, type: "配件" },
    { item: char.secondAccessory, type: "配件" },
    { item: char.tacticalItem, type: "戰術物品", isTac: true },
  ];

  // Draw Left Column
  for (let i = 0; i < leftItems.length; i++) {
    const e = leftItems[i];
    const ex = egX;
    const ey = egY + i * (itemH_L + eGap);

    ctx.fillStyle = "#fcfcfc";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 8;
    roundRect(ctx, ex, ey, colW1, itemH_L, 15, true);
    ctx.shadowBlur = 0;

    if (e.item) {
      const ed = e.item.equipData;
      const rKey = ed.rarity?.key || "";
      ctx.fillStyle = getRarityColor(rKey);
      ctx.fillRect(ex, ey, 12, itemH_L);

      ctx.fillStyle = "#111";
      ctx.font = "bold 44px NotoSansTCBold";
      const lvVal = ed.level?.value || "??";
      ctx.fillText(`${lvVal}`, ex + 35, ey + 60);
      const lvW = ctx.measureText(lvVal).width;
      ctx.font = "18px NotoSans";
      ctx.fillText("LEVEL", ex + 35 + lvW + 10, ey + 60);

      // Stars
      const eRarity = parseInt(rKey.split("_").pop() || "0");
      for (let j = 0; j < eRarity; j++) {
        ctx.drawImage(starImg, ex + 35 + j * 32, ey + 75, 28, 28);
      }

      // Suit Skill Description
      let skillY = ey + 130;
      const nameY = ey + itemH_L - 25;
      if (ed.suit && ed.suit.skillDesc) {
        const skillStr = parseEffectString(
          ed.suit.skillDesc,
          ed.suit.skillDescParams,
        );
        ctx.fillStyle = "#666";
        ctx.font = "20px NotoSansTCBold";
        wrapText(
          ctx,
          skillStr,
          ex + 30,
          skillY,
          colW1 - 60,
          28,
          nameY - 45 - skillY,
        );
      }

      // Properties and Suit Name at the bottom right, aligned with name
      const props = ed.properties || [];
      const suitName = ed.suit?.name;
      let currentRightX = ex + colW1 - 30;

      // Render segments in reverse to align right
      [...props]
        .slice(0, 3)
        .reverse()
        .forEach((pKey: string) => {
          const enumItem = enums.find((v: any) => v.key === pKey);
          const labelText = enumItem?.value || pKey.replace("equip_attr_", "");
          if (!labelText) return;

          ctx.font = "bold 22px NotoSansTCBold";
          const textW = ctx.measureText(labelText).width;
          const bgW = textW + 24;
          const labelX = currentRightX - bgW;

          ctx.fillStyle = "rgba(0,0,0,0.05)";
          roundRect(ctx, labelX, nameY - 32, bgW, 40, 6, true);
          ctx.fillStyle = "#555";
          ctx.textAlign = "center";
          ctx.fillText(labelText, labelX + bgW / 2, nameY - 4);
          ctx.textAlign = "left";
          currentRightX -= bgW + 12;
        });

      // Suit Name Pill
      if (suitName) {
        ctx.font = "bold 22px NotoSansTCBold";
        const tw = ctx.measureText(suitName).width;
        const bgW = tw + 24;
        const labelX = currentRightX - bgW;

        ctx.fillStyle = getRarityColor(rKey);
        roundRect(ctx, labelX, nameY - 32, bgW, 40, 6, true);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(suitName, labelX + bgW / 2, nameY - 4);
        ctx.textAlign = "left";
        currentRightX -= bgW + 12;
      }

      // Name at the very bottom, with dynamic max width to avoid overlap
      ctx.fillStyle = "#111";
      ctx.font = "bold 32px NotoSansTCBold";
      const availableNameW = currentRightX - (ex + 35) - 15; // 15px gap
      ctx.fillText(ed.name || "未知", ex + 35, nameY, availableNameW);

      if (ed.iconUrl) {
        try {
          const eImg = await fetchImage(ed.iconUrl);
          ctx.drawImage(eImg, ex + colW1 - 160, ey + 10, 150, 150);
        } catch (e) {}
      }
    } else {
      drawPlaceholder(ex, ey, colW1, itemH_L);
    }
  }

  // Draw Right Column
  for (let i = 0; i < rightItems.length; i++) {
    const e = rightItems[i];
    const ex = egX + colW1 + eGap;
    const ey = egY + i * (itemH_R + eGap);

    ctx.fillStyle = "#fcfcfc";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 8;
    roundRect(ctx, ex, ey, colW2, itemH_R, 15, true);
    ctx.shadowBlur = 0;

    if (e.item) {
      const data = e.isTac ? e.item.tacticalItemData : e.item.equipData;
      const rKey = data?.rarity?.key || "";
      ctx.fillStyle = getRarityColor(rKey);
      ctx.fillRect(ex, ey, 12, itemH_R);

      if (e.isTac) {
        ctx.fillStyle = "#111";
        ctx.font = "bold 32px NotoSansTCBold";
        ctx.fillText(data?.name || "未知", ex + 35, ey + 50);

        const tRarity = parseInt(rKey.split("_").pop() || "0");
        for (let j = 0; j < tRarity; j++) {
          ctx.drawImage(starImg, ex + 35 + j * 24, ey + 65, 22, 22);
        }

        // Tactical Item Effect
        const effectStr = parseEffectString(
          data?.activeEffect,
          data?.activeEffectParams,
        );
        if (effectStr) {
          ctx.fillStyle = "#666";
          ctx.font = "22px NotoSansTCBold";
          wrapText(
            ctx,
            effectStr,
            ex + 35,
            ey + 120,
            colW2 - 50,
            30,
            itemH_R - 110,
          );
        }
      } else {
        ctx.fillStyle = "#111";
        ctx.font = "bold 36px NotoSansTCBold";
        const lvVal = data?.level?.value || "??";
        ctx.fillText(`${lvVal}`, ex + 35, ey + 45);
        const lvW = ctx.measureText(lvVal).width;
        ctx.font = "16px NotoSans";
        ctx.fillText("LEVEL", ex + 35 + lvW + 10, ey + 45);

        // Stars
        const aRarity = parseInt(rKey.split("_").pop() || "0");
        for (let j = 0; j < aRarity; j++) {
          ctx.drawImage(starImg, ex + 35 + j * 26, ey + 55, 24, 24);
        }

        // Suit Skill Description
        let finalY = ey + 105;
        const nameY = ey + itemH_R - 25;
        if (data?.suit && data?.suit.skillDesc) {
          const skillStr = parseEffectString(
            data.suit.skillDesc,
            data.suit.skillDescParams,
          );
          ctx.fillStyle = "#666";
          ctx.font = "20px NotoSansTCBold";
          wrapText(
            ctx,
            skillStr,
            ex + 30,
            finalY,
            colW2 - 45,
            22,
            nameY - 10 - finalY,
          );
        }

        // Properties and Suit Name at the bottom right, aligned with name
        const props = data?.properties || [];
        const suitName = data?.suit?.name;
        let currentRightX = ex + colW2 - 30;

        [...props]
          .slice(0, 3)
          .reverse()
          .forEach((pKey: string) => {
            const enumItem = enums.find((v: any) => v.key === pKey);
            const labelText =
              enumItem?.value || pKey.replace("equip_attr_", "");
            if (!labelText) return;

            ctx.font = "bold 20px NotoSansTCBold";
            const textW = ctx.measureText(labelText).width;
            const bgW = textW + 18;
            const labelX = currentRightX - bgW;

            ctx.fillStyle = "rgba(0,0,0,0.05)";
            roundRect(ctx, labelX, nameY - 28, bgW, 35, 5, true);
            ctx.fillStyle = "#555";
            ctx.textAlign = "center";
            ctx.fillText(labelText, labelX + bgW / 2, nameY - 4);
            ctx.textAlign = "left";
            currentRightX -= bgW + 10;
          });

        // Suit Name Pill
        if (suitName) {
          ctx.font = "bold 20px NotoSansTCBold";
          const tw = ctx.measureText(suitName).width;
          const bgW = tw + 24; // use consistent bgW
          const labelX = currentRightX - bgW;

          ctx.fillStyle = getRarityColor(rKey);
          roundRect(ctx, labelX, nameY - 28, bgW, 35, 5, true);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.fillText(suitName, labelX + bgW / 2, nameY - 4);
          ctx.textAlign = "left";
          currentRightX -= bgW + 10;
        }

        // Name at the bottom, with dynamic max width to avoid overlap
        ctx.fillStyle = "#111";
        ctx.font = "bold 28px NotoSansTCBold";
        const availableNameW = currentRightX - (ex + 35) - 15; // 15px gap
        ctx.fillText(data?.name || "未知", ex + 35, nameY, availableNameW);
      }

      if (data?.iconUrl) {
        try {
          const eImg = await fetchImage(data.iconUrl);
          ctx.drawImage(eImg, ex + colW2 - 150, ey + 10, 140, 140);
        } catch (e) {}
      }
    } else {
      drawPlaceholder(ex, ey, colW2, itemH_R);
    }
  }

  return canvas.toBuffer("image/png");
}
