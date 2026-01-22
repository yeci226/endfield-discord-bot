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

  // PRE-LOAD ALL ASSETS IN PARALLEL
  const charAssetsPromises = chars.map(async (char) => {
    let avatarImg: Image | null = null;
    let profImg: Image | null = null;
    let propImg: Image | null = null;
    let weaponImg: Image | null = null;
    let phaseImg: Image | null = null;

    const iconUrl = char.charData.avatarSqUrl || char.charData.avatarRtUrl;
    if (iconUrl) {
      try {
        avatarImg = await fetchImage(iconUrl);
      } catch (e) {
        // console.error("Failed to load avatar", e);
      }
    }

    const profKey = char.charData.profession?.key;
    if (profKey) {
      const strippedKey = profKey.replace("profession_", "").toLowerCase();
      try {
        profImg = await loadLocalImage(`prof/${strippedKey}.jpg`);
      } catch (e) {
        console.error(`[Canvas] Failed to load prof icon: ${strippedKey}`);
      }
    }

    const propKey = char.charData.property?.key;
    if (propKey) {
      const strippedKey = propKey.replace("char_property_", "").toLowerCase();
      try {
        propImg = await loadLocalImage(`element/${strippedKey}.jpg`);
      } catch (e) {
        console.error(`[Canvas] Failed to load property icon: ${strippedKey}`);
      }
    }

    const weaponKey = char.charData.weaponType?.key;
    if (weaponKey) {
      const strippedKey = weaponKey.replace("weapon_type_", "").toLowerCase();
      try {
        weaponImg = await loadLocalImage(`weapon/black/${strippedKey}.png`);
      } catch (e) {
        console.error(`[Canvas] Failed to load weapon icon: ${strippedKey}`);
      }
    }

    if (char.evolvePhase !== undefined) {
      try {
        phaseImg = await loadLocalImage(`phase/${char.evolvePhase}.webp`);
      } catch (e) {}
    }

    return {
      char,
      avatarImg,
      profImg,
      propImg,
      weaponImg,
      phaseImg,
    };
  });

  const loadedChars = await Promise.all(charAssetsPromises);

  for (let i = 0; i < loadedChars.length; i++) {
    const { char, avatarImg, profImg, propImg, weaponImg, phaseImg } =
      loadedChars[i];
    const row = Math.floor(i / charCols);
    const col = i % charCols;
    const x = padding + (charWidth + charGap) * col;
    const y = charGridY + (charHeight + charGap) * row;

    if (y + charHeight > height) break;

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
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return await loadImage(Buffer.from(response.data));
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
// ... (Existing code)

export async function drawCharacterDetail(char: any): Promise<Buffer> {
  const width = 2400;
  const height = 1200;
  const leftW = 720; // 30% of 2400
  const padding = 60;
  const rightX = leftW + 60;
  const rightW = width - rightX - padding;

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

  // 1. Backgrounds
  ctx.fillStyle = "#f2f2f2"; // Base
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#d8d8d8"; // Left Panel
  ctx.fillRect(0, 0, leftW, height);

  // 2. Character Art (Left Panel)
  const imgUrl =
    char.charData.illustrationUrl ||
    char.charData.avatarRtUrl ||
    char.charData.avatarSqUrl;
  if (imgUrl) {
    try {
      const img = await fetchImage(imgUrl);
      const ratio = img.width / img.height;
      let drawH = height;
      let drawW = height * ratio;
      const x = (leftW - drawW) / 2;
      ctx.drawImage(img, x, 0, drawW, drawH);
    } catch (e) {
      console.error("Failed to load art", e);
    }
  }

  // Fade art at bottom
  const grad = ctx.createLinearGradient(0, height - 350, 0, height);
  grad.addColorStop(0, "rgba(216, 216, 216, 0)");
  grad.addColorStop(1, "rgba(216, 216, 216, 1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, height - 350, leftW, 350);

  // 3. Left Panel Info
  const contentY = height - 100;

  // Name
  ctx.fillStyle = "#111111";
  ctx.font = "bold 90px NotoSansTCBold";
  ctx.textAlign = "left";
  ctx.fillText(char.charData.name, padding, contentY - 140);

  // Level Badge
  const lvBoxW = 220;
  const lvBoxH = 120;
  const lvX = leftW - lvBoxW - 40;
  const lvY = contentY - 260;
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  roundRect(ctx, lvX, lvY, lvBoxW, lvBoxH, 15, true);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 70px NotoSansTCBold";
  ctx.fillText(`${char.level}`, lvX + 25, lvY + 85);
  ctx.font = "24px NotoSans";
  ctx.fillText("Level", lvX + 115, lvY + 85);

  // Icons Row: Profession, Property, WeaponType
  const iconSize = 70;
  const iconGap = 25;
  let curIX = padding;
  const iconY = contentY - 100;

  // Prof
  const profKey = char.charData.profession?.key;
  if (profKey) {
    try {
      const img = await loadLocalImage(
        `prof/${profKey.replace("profession_", "").toLowerCase()}.jpg`,
      );
      ctx.drawImage(img, curIX, iconY, iconSize, iconSize);
      curIX += iconSize + iconGap;
    } catch (e) {}
  }
  // Prop
  const propKey = char.charData.property?.key;
  if (propKey) {
    try {
      const img = await loadLocalImage(
        `element/${propKey.replace("char_property_", "").toLowerCase()}.jpg`,
      );
      ctx.drawImage(img, curIX, iconY, iconSize, iconSize);
      curIX += iconSize + iconGap;
    } catch (e) {}
  }
  // WeaponType
  const wKey = char.charData.weaponType?.key;
  if (wKey) {
    try {
      const img = await loadLocalImage(
        `weapon/black/${wKey.replace("weapon_type_", "").toLowerCase()}.png`,
      );
      ctx.drawImage(img, curIX, iconY, iconSize, iconSize);
      curIX += iconSize + iconGap;
    } catch (e) {}
  }

  // Potential Rank (Dots)
  const potSize = 20;
  const potGap = 12;
  const potTotal = 6;
  const potLevel = char.potentialLevel || 0;
  const potY = iconY + iconSize + 30;
  for (let i = 0; i < potTotal; i++) {
    ctx.fillStyle = i < potLevel ? "#ffcc00" : "#aaaaaa";
    ctx.beginPath();
    ctx.arc(
      padding + i * (potSize + potGap) + potSize / 2,
      potY,
      potSize / 2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // --- RIGHT SECTION ---

  // 4. Skills (Top section of right)
  const skillsY = 80;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 技能", rightX, skillsY);

  const skY = skillsY + 20;
  const skSize = 130;
  const skList = char.charData.skills || [];
  for (let i = 0; i < 4; i++) {
    const s = skList[i];
    const sx = rightX + i * (skSize + 110);

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
    ctx.fillStyle = "#222";
    ctx.font = "bold 28px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(s?.name || "未知", sx + skSize / 2, skY + skSize + 65);
    ctx.font = "bold 20px NotoSans";
    ctx.fillStyle = "#666";
    ctx.fillText("RANK 1", sx + skSize / 2, skY + skSize + 95);
  }
  ctx.textAlign = "left";

  // 5. Weapon & Tactical Cards (Side by side?)
  // Actually, let's keep vertical for space if we want 3x2 grid.
  // Col 1 (Right): Skills + Weapon
  // Col 2 (Right): Equipment Grid

  const col1W = 850;

  // Weapon Card
  const weaponY = 380;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 武器", rightX, weaponY);

  const wCardW = col1W;
  const wCardH = 260;
  const wCardY = weaponY + 30;
  ctx.fillStyle = "#fcfcfc";
  ctx.shadowColor = "rgba(0,0,0,0.05)";
  ctx.shadowBlur = 10;
  roundRect(ctx, rightX, wCardY, wCardW, wCardH, 15, true);
  ctx.shadowBlur = 0;

  if (char.weapon) {
    const wd = char.weapon.weaponData;
    ctx.fillStyle = "#111";
    ctx.font = "bold 70px NotoSansTCBold";
    ctx.fillText(`${char.weapon.level}`, rightX + 35, wCardY + 90);
    ctx.font = "26px NotoSans";
    ctx.fillText("LEVEL", rightX + 145, wCardY + 90);

    ctx.fillStyle = "#a38634"; // Stars
    ctx.font = "30px NotoSans";
    const rarity = parseInt(wd.rarity?.value) || 0;
    ctx.fillText("★".repeat(rarity), rightX + 35, wCardY + 140);

    ctx.fillStyle = "#111";
    ctx.font = "bold 40px NotoSansTCBold";
    ctx.fillText(wd.name || "Unknown", rightX + 35, wCardY + 200);

    if (wd.iconUrl) {
      try {
        const wImg = await fetchImage(wd.iconUrl);
        ctx.save();
        ctx.translate(rightX + wCardW - 130, wCardY + 130);
        ctx.rotate(-Math.PI / 10);
        ctx.drawImage(wImg, -110, -110, 220, 220);
        ctx.restore();
      } catch (e) {}
    }
  }

  // 6. Equipment Grid (3x2) - Right Column
  const gridX = rightX + col1W + 40;
  const gridY = skillsY;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText("I 裝備", gridX, gridY);

  const eCardW = width - gridX - padding - 30;
  const eCardH = 230;
  const eGap = 25;
  const eGridY = gridY + 30;

  // Layout logic based on user:
  // Body (0,0)  | Accessory 1 (0,1)
  // Arm (1,0)   | (Empty/Acc 2) (1,1)
  // (Empty) (2,0)| Tactical (2,1)

  const equipGrid = [
    { item: char.bodyEquip, pos: [0, 0] },
    { item: char.firstAccessory, pos: [0, 1] },
    { item: char.armEquip, pos: [1, 0] },
    { item: null, pos: [1, 1] },
    { item: null, pos: [2, 0] },
    { item: char.tacticalItem, pos: [2, 1], isTac: true },
  ];

  const colW = (eCardW - eGap) / 2;

  for (const e of equipGrid) {
    const ex = gridX + e.pos[1] * (colW + eGap);
    const ey = eGridY + e.pos[0] * (eCardH + eGap);

    ctx.fillStyle = "#fcfcfc";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 8;
    roundRect(ctx, ex, ey, colW, eCardH, 15, true);
    ctx.shadowBlur = 0;

    if (e.item || e.isTac) {
      const data = e.item?.equipData || (e.item as any)?.tacticalItemData;
      const level =
        e.item?.level || (e.item as any)?.level || (e.item as any)?.weaponData
          ? "Weapon"
          : "??";

      // If it's Tactical Item, it might have different structure
      const isTactical = e.isTac;
      const itemName = data?.name || (e.item as any)?.name || "未知";
      const itemLevel = level;

      ctx.fillStyle = "#111";
      ctx.font = "bold 60px NotoSansTCBold";
      ctx.fillText(`${itemLevel}`, ex + 25, ey + 75);
      ctx.font = "22px NotoSans";
      ctx.fillText("LEVEL", ex + 105, ey + 75);

      ctx.font = "bold 32px NotoSansTCBold";
      ctx.fillText(itemName, ex + 30, ey + 155);

      const iconUrl = data?.iconUrl || (e.item as any)?.iconUrl;
      if (iconUrl) {
        try {
          const img = await fetchImage(iconUrl);
          ctx.drawImage(img, ex + colW - 170, ey + 15, 160, 160);
        } catch (e) {}
      }
    } else {
      // Dotted placeholder
      ctx.strokeStyle = "#ddd";
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 3;
      ctx.strokeRect(ex + 30, ey + 30, colW - 60, eCardH - 60);
      ctx.setLineDash([]);

      // Small circle icon in middle
      ctx.beginPath();
      ctx.arc(ex + colW / 2, ey + eCardH / 2, 40, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return canvas.toBuffer("image/png");
}
