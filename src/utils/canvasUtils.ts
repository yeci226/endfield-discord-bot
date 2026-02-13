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
import { ProfileTemplate } from "../interfaces/ProfileTemplate";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import { EnumService } from "../services/EnumService";
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

export async function drawDashboard(
  detail: CardDetail,
  tr: any,
  template: ProfileTemplate = ProfileTemplateService.getDefaultTemplate(),
): Promise<Buffer> {
  const { base, chars } = detail;
  const { canvas: cv, elements: el } = template;

  // Canvas dimensions
  const width = cv.width;
  const padding = cv.padding;

  // Calculate required height based on characters
  const charCols = el.operatorsGrid.cols || 10;
  const charGap = el.operatorsGrid.gap || 15;
  const charWidth = el.operatorsGrid.charWidth || 210;
  const charHeight = el.operatorsGrid.charHeight || 270;
  const charImageSize = charWidth;

  const charGridY = el.operatorsGrid.y;
  const rows = Math.ceil(chars.length / charCols);
  const requiredCharGridHeight = rows * (charHeight + charGap);

  let height = cv.height;
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

  // Helper for styling wrappers
  const withStyles = (
    element: any,
    centerX: number,
    centerY: number,
    drawFn: () => void,
  ) => {
    if (!element.visible) return;
    ctx.save();
    // Rotation/Translation could go here if added to template
    // For now just check visibility
    drawFn();
    ctx.restore();
  };

  // 1. Background
  try {
    const bgUrl = template.background.url;
    const bg = bgUrl.startsWith("http")
      ? await fetchImage(bgUrl)
      : await loadLocalImage(bgUrl);

    // 1.1 Handle Background Fill Color
    if (template.background.fillColor) {
      ctx.fillStyle = template.background.fillColor;
      ctx.fillRect(0, 0, width, height);
    }

    // Main Background Drawing
    const bgRatio = bg.width / bg.height;
    const canvasRatio = width / height;

    let drawW, drawH, offsetX, offsetY;

    if (template.background.scale !== undefined) {
      // Use custom transform if valid
      const scale = template.background.scale;
      drawW = bg.width * scale;
      drawH = bg.height * scale;
      // Frontend saves center coordinates (originX: center, originY: center)
      // Backend drawImage expects top-left coordinates
      // But wait! Creating the offset relative to center of canvas?
      // No, frontend usually sends X/Y relative to canvas top-left if origin is top-left.
      // But fabric default origin is center->center.
      // Let's assume standard top-left mapping for now or use the previous fix.
      const bgX = template.background.x || 0;
      const bgY = template.background.y || 0;
      // Conversion from Center Origin to Top-Left
      offsetX = bgX - drawW / 2;
      offsetY = bgY - drawH / 2;

      ctx.drawImage(bg, offsetX, offsetY, drawW, drawH);
    } else {
      // Default 'Cover' logic
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
    }
  } catch (e) {
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, width, height);
  }

  // Overlay
  if (template.background.overlay) {
    ctx.fillStyle = template.background.overlay;
    ctx.fillRect(0, 0, width, height);
  }

  // Header (Avatar + Info)
  if (el.avatar.visible) {
    const avatarSize = el.avatar.width || 180;
    // Draw Avatar
    ctx.save();
    roundRect(
      ctx,
      el.avatar.x,
      el.avatar.y,
      avatarSize,
      avatarSize,
      el.avatar.radius || 30,
    );
    ctx.clip();
    if (base.avatarUrl) {
      try {
        const avatarImg = await fetchImage(base.avatarUrl);
        ctx.drawImage(
          avatarImg,
          el.avatar.x,
          el.avatar.y,
          avatarSize,
          avatarSize,
        );
      } catch (e) {
        ctx.fillStyle = "#333";
        ctx.fillRect(el.avatar.x, el.avatar.y, avatarSize, avatarSize);
      }
    }
    ctx.restore();
  }

  // Name
  if (el.name.visible) {
    ctx.fillStyle = el.name.color || "#ffffff";
    const nameMaxW = width - el.name.x - padding; // Approximate
    fillDynamicText(
      ctx,
      base.name,
      el.name.x,
      el.name.y,
      nameMaxW,
      el.name.fontSize || 80,
      el.name.bold !== false,
    );
  }

  // Badge / Info Text
  if (el.badge.visible) {
    ctx.font = `${el.badge.fontSize || 32}px NotoSans`;
    ctx.fillStyle = el.badge.color || "#aaaaaa";
    const awakeDate = moment(parseInt(base.createTime) * 1000).format(
      tr("Year") === "年" ? "YYYY/MM/DD" : "MM/DD/YYYY",
    );
    const lastLoginTime = moment(parseInt(base.lastLoginTime) * 1000).format(
      tr("Year") === "年" ? "YYYY/MM/DD" : "MM/DD/YYYY",
    );

    const badgeText = `UID ${base.roleId} | ${tr("canvas_AwakeDate")} ${awakeDate} | ${tr("canvas_LastLogin")} ${lastLoginTime}`;

    if (tr.lang === "en") {
      const serverNameW = ctx.measureText(base.serverName).width;
      const infoMaxW = width - el.badge.x - serverNameW - padding - 40;
      fillDynamicText(
        ctx,
        badgeText,
        el.badge.x,
        el.badge.y,
        infoMaxW,
        el.badge.fontSize || 32,
        false,
      );

      ctx.textAlign = "right";
      ctx.fillStyle = "#aaaaaa"; // Keeping same color
      ctx.font = `${el.badge.fontSize || 32}px NotoSans`;
      ctx.fillText(base.serverName, width - padding, el.badge.y);
      ctx.textAlign = "left";
    } else {
      // CN/TW
      ctx.font = `${el.badge.fontSize || 36}px NotoSans`;
      ctx.fillText(`${badgeText} | ${base.serverName}`, el.badge.x, el.badge.y);
    }
  }

  // 3. Stats Grid
  if (el.statsGrid.visible) {
    const itemW = el.statsGrid.itemWidth || 537.5;
    const itemH = el.statsGrid.height || 140;
    const gap = el.statsGrid.gap || 30;

    const stats = [
      { label: tr("canvas_ExploreLevel"), value: base.worldLevel.toString() },
      { label: tr("canvas_Operators"), value: base.charNum.toString() },
      { label: tr("canvas_Weapons"), value: base.weaponNum.toString() },
      { label: tr("canvas_Files"), value: base.docNum.toString() },
    ];

    stats.forEach((stat, i) => {
      const x = el.statsGrid.x + (itemW + gap) * i;
      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      roundRect(ctx, x, el.statsGrid.y, itemW, itemH, 20, true);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 56px NotoSansTCBold";
      ctx.textAlign = "center";
      ctx.fillText(stat.value, x + itemW / 2, el.statsGrid.y + 65);

      ctx.fillStyle = "#aaaaaa";
      ctx.font = "28px NotoSans";
      ctx.fillText(stat.label, x + itemW / 2, el.statsGrid.y + 110);
    });
    ctx.textAlign = "left";
  }

  // 3.5. Mission & Level

  // Mission Box
  if (el.missionBox.visible) {
    const mlY = el.missionBox.y;
    const mlH = el.missionBox.height || 160;
    const missionW = el.missionBox.width || 1558;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, el.missionBox.x, mlY, missionW, mlH, 20, true);

    if (base.mainMission) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 60px NotoSansTCBold";
      ctx.textAlign = "left";
      ctx.fillText(
        base.mainMission.description,
        el.missionBox.x + 40,
        mlY + 70,
      );

      ctx.fillStyle = "#aaaaaa";
      ctx.font = "32px NotoSans";
      ctx.fillText(tr("canvas_MainMission"), el.missionBox.x + 40, mlY + 120);
    }
  }

  // Level Box
  if (el.authLevelBox.visible) {
    const authX = el.authLevelBox.x;
    const authY = el.authLevelBox.y;
    const authW = el.authLevelBox.width || 662;
    const authH = el.authLevelBox.height || 160;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, authX, authY, authW, authH, 20, true);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 80px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(base.level.toString(), authX + authW / 2, authY + 80);

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "32px NotoSans";
    ctx.fillText(tr("canvas_AuthLevel"), authX + authW / 2, authY + 130);
    ctx.textAlign = "left";
  }

  // 4. Real-time Data Title
  if (el.realtimeTitle.visible) {
    const rtY = el.realtimeTitle.y;
    const rtX = el.realtimeTitle.x; // 150

    // Default style based on original
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${el.realtimeTitle.fontSize || 50}px NotoSansTCBold`;
    // The old code drew rects relative to "padding".
    // Need to adjust to new dynamic X if possible, or stick to padding logic if X is close to padding?
    // Old logic: text at padding + 70 (150). Rects at padding.
    // So if el.realtimeTitle.x is 150, the rects should be at x - 70 = 80?
    const decorX = rtX - 70; // 80 (Padding)

    ctx.fillText(tr("canvas_RealtimeData"), rtX, rtY + 40);

    // Rects
    ctx.fillRect(decorX, rtY + 10, 12, 35);
    ctx.fillRect(decorX + 20, rtY - 5, 12, 50);
    ctx.fillRect(decorX + 40, rtY + 15, 12, 25);
  }

  const { dungeon, dailyMission, bpSystem } = detail;

  // Stamina Box (Left)
  if (el.staminaBox.visible && dungeon) {
    const staX = el.staminaBox.x;
    const staY = el.staminaBox.y;
    const staW = el.staminaBox.width || 750;
    const staH = el.staminaBox.height || 180;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, staX, staY, staW, staH, 20, true);

    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 70px NotoSansTCBold";
    const curStamina = dungeon.curStamina;
    // Y from top: staY + 80? Original was realTimeY + 160.
    // realTimeY = 670. staY = 750. Diff = 80. So realTimeY + 160 = staY + 80.
    ctx.fillText(curStamina, staX + 40, staY + 80);
    const curWidth = ctx.measureText(curStamina).width;

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "36px NotoSans";
    ctx.fillText(
      `/ ${dungeon.maxStamina}`,
      staX + 40 + curWidth + 15,
      staY + 80,
    );

    // Recovery Time Logics
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
      recoveryText = `${h}${tr("Hour")}${m}${tr("Minute")}`;
    } else if (parseInt(dungeon.curStamina) >= parseInt(dungeon.maxStamina)) {
      recoveryText = tr("canvas_FullyRecovered");
    }

    // Dynamic Color
    const maxRecoverySec = (parseInt(dungeon.maxStamina) / 10) * 60 * 60;
    const ratio = Math.min(diff / maxRecoverySec, 1);
    const hue = 120 * (1 - ratio);
    const dotColor = `hsl(${hue}, 100%, 50%)`;

    // Dimensions
    ctx.font = "30px NotoSans";
    const recTextW = ctx.measureText(recoveryText).width;
    const dotR = 8;
    const dotGap = 12;
    const pillPaddingX = 20;
    const pillPaddingY = 12;
    const pillW = pillPaddingX * 2 + dotR * 2 + dotGap + recTextW;
    const pillH = 30 + pillPaddingY * 2;

    const pillX = staX + staW - pillW - 30; // Right aligned
    const pillY = staY + 30; // approx

    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
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
    ctx.fillText(recoveryText, dotX + dotR + dotGap, pillY + pillH / 2 + 11);

    // Labels
    ctx.textAlign = "left";
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "24px NotoSans";
    const labelY = staY + 130;
    ctx.fillText(tr("canvas_Stamina"), staX + 40, labelY);
    ctx.textAlign = "right";
    ctx.fillText(tr("canvas_RecoveryTime"), staX + staW - 30, labelY);
    ctx.textAlign = "left";
  }

  // Activity Box (Right)
  if (el.activityBpBox.visible) {
    const actX = el.activityBpBox.x;
    const actY = el.activityBpBox.y;
    const actW = el.activityBpBox.width || 1450;
    const actH = el.activityBpBox.height || 180;
    const halfW = actW / 2;
    const centerY = actY + actH / 2;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, actX, actY, actW, actH, 20, true);

    if (dailyMission) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 56px NotoSansTCBold";
      ctx.fillText(
        `${dailyMission.dailyActivation}/${dailyMission.maxDailyActivation}`,
        actX + halfW / 2,
        centerY + 10,
      );
      ctx.fillStyle = "#aaaaaa";
      ctx.font = "28px NotoSans";
      ctx.fillText(tr("canvas_Activity"), actX + halfW / 2, centerY + 55);
    }

    if (bpSystem) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 56px NotoSansTCBold";
      ctx.fillText(
        `${bpSystem.curLevel}/${bpSystem.maxLevel}`,
        actX + halfW + halfW / 2,
        centerY + 10,
      );
      ctx.fillStyle = "#aaaaaa";
      ctx.font = "28px NotoSans";
      ctx.fillText(tr("canvas_BP"), actX + halfW + halfW / 2, centerY + 55);
    }
    ctx.textAlign = "left";
  }

  // Operators Title
  if (el.operatorsTitle.visible) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${el.operatorsTitle.fontSize || 50}px NotoSansTCBold`;
    ctx.fillText(
      tr("canvas_Operators"),
      el.operatorsTitle.x,
      el.operatorsTitle.y,
    );
  }

  // Operators Grid
  if (el.operatorsGrid.visible) {
    const gridX = el.operatorsGrid.x;
    const gridY = el.operatorsGrid.y;

    // Asset Preloading
    const charAssetsPromises = chars.map(async (char) => {
      if (
        el.operatorsGrid.limit &&
        chars.indexOf(char) >= el.operatorsGrid.limit
      )
        return;
      const iconUrl = char.charData.avatarSqUrl || char.charData.avatarRtUrl;
      if (iconUrl) fetchImage(iconUrl).catch(() => {});

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

      const phase = Number(char.evolvePhase) || 0;
      if (phase > 0) {
        loadLocalImage(`phase/${phase}.png`).catch(() => {});
        loadLocalImage("phase/bg.png").catch(() => {});
      }
    });
    await Promise.all(charAssetsPromises);

    for (let i = 0; i < chars.length; i++) {
      if (el.operatorsGrid.limit && i >= el.operatorsGrid.limit) break;

      const char = chars[i];
      const row = Math.floor(i / charCols);
      const col = i % charCols;
      const x = gridX + (charWidth + charGap) * col;
      const y = gridY + (charHeight + charGap) * row;

      if (y + charHeight > height) break;

      // Image Loading
      const iconUrl = char.charData.avatarSqUrl || char.charData.avatarRtUrl;
      let avatarImg: Image | null = null;
      try {
        avatarImg = iconUrl ? await fetchImage(iconUrl) : null;
      } catch (e) {}

      let profImg: Image | null = null;
      let propImg: Image | null = null;
      let weaponImg: Image | null = null;
      let phaseImg: Image | null = null;

      // Load assets safely...
      try {
        if (char.charData.profession?.key)
          profImg = await loadLocalImage(
            `prof/${char.charData.profession.key.replace("profession_", "").toLowerCase()}.jpg`,
          );
        if (char.charData.property?.key)
          propImg = await loadLocalImage(
            `element/${char.charData.property.key.replace("char_property_", "").toLowerCase()}.jpg`,
          );
        if (char.charData.weaponType?.key)
          weaponImg = await loadLocalImage(
            `weapon/black/${char.charData.weaponType.key.replace("weapon_type_", "").toLowerCase()}.png`,
          );
        if (char.evolvePhase && char.evolvePhase > 0)
          phaseImg = await loadLocalImage(`phase/${char.evolvePhase}.png`);
      } catch (e) {}

      // Card Drawing
      ctx.save();
      const radius = 15;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + charImageSize - radius, y);
      ctx.arcTo(x + charImageSize, y, x + charImageSize, y + radius, radius);
      ctx.lineTo(x + charImageSize, y + charImageSize);
      ctx.lineTo(x, y + charImageSize);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
      ctx.closePath();

      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.clip();

      if (avatarImg)
        ctx.drawImage(avatarImg, x, y, charImageSize, charImageSize);
      else {
        ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
        ctx.fillRect(x, y, charImageSize, charImageSize);
      }
      ctx.restore();

      // Icons
      const iconSize = 36;
      const iconPadding = 8;
      if (profImg)
        ctx.drawImage(
          profImg,
          x + iconPadding,
          y + iconPadding,
          iconSize,
          iconSize,
        );
      if (propImg)
        ctx.drawImage(
          propImg,
          x + iconPadding,
          y + iconPadding + iconSize + iconPadding,
          iconSize,
          iconSize,
        );
      if (weaponImg)
        ctx.drawImage(
          weaponImg,
          x + iconPadding,
          y + iconPadding + (iconSize + iconPadding) * 2,
          iconSize,
          iconSize,
        );

      // Level
      ctx.textAlign = "left";
      const levelText = `${char.level}`;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";

      ctx.font = "18px NotoSans";
      ctx.strokeText("Lv.", x + 10, y + charImageSize - 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("Lv.", x + 10, y + charImageSize - 18);
      const lvPrefixWidth = ctx.measureText("Lv.").width;

      ctx.font = "bold 28px NotoSansTCBold";
      ctx.strokeText(
        levelText,
        x + 10 + lvPrefixWidth + 2,
        y + charImageSize - 18,
      );
      ctx.fillText(
        levelText,
        x + 10 + lvPrefixWidth + 2,
        y + charImageSize - 18,
      );

      // Phase
      if (char.evolvePhase !== undefined && char.evolvePhase > 0) {
        try {
          const phaseBg = await loadLocalImage("phase/bg.png");
          const phaseSize = 32;
          const phaseX = x + charImageSize - 45;
          const phaseY = y + charImageSize - 40;
          ctx.drawImage(phaseBg, phaseX, phaseY, phaseSize, phaseSize);
          if (phaseImg) {
            const numSize = phaseSize * (204 / 336);
            const numX = phaseX + (phaseSize - numSize) / 2;
            const numY = phaseY + (phaseSize - numSize) / 2;
            ctx.save();
            ctx.beginPath();
            ctx.arc(
              numX + numSize / 2,
              numY + numSize / 2,
              numSize / 2,
              0,
              Math.PI * 2,
            );
            ctx.clip();
            ctx.drawImage(phaseImg, numX, numY, numSize, numSize);
            ctx.restore();
          }
        } catch (e) {}
      }

      // Rarity Bar
      const getRarityColor = (r: number) => {
        const colors: any = {
          6: "rgba(255, 113, 0, 1)",
          5: "rgba(255, 204, 0, 1)",
          4: "rgba(179, 128, 255, 1)",
          3: "rgba(51, 194, 255, 1)",
          2: "rgba(180, 217, 69, 1)",
          1: "rgba(178, 178, 178, 1)",
        };
        return colors[r] || "rgba(178, 178, 178, 1)";
      };
      const rarity = parseInt(char.charData.rarity?.value) || 0;
      ctx.fillStyle = getRarityColor(rarity);
      ctx.fillRect(x, y + charImageSize - 6, charImageSize, 6);

      // Name
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px NotoSansTCBold";
      ctx.fillText(
        char.charData.name,
        x + charWidth / 2,
        y + charImageSize + 35,
      );
    }
  }

  // Fabric Objects support (for User Edited Stuff)
  if (template.fabricJson && template.fabricJson.objects) {
    // NOTE: This usually replaces the entire drawing logic if present,
    // but for "User Editing" we usually want to draw the *fabric objects* ON TOP
    // or instead of the hardcoded stuff.
    // However, the current logic in previous steps was: "If fabricJson exists, draw ONLY fabricJson".
    // This is because fabricJson represents the *entire* state of the canvas including background and elements.
    // So if the user has saved a layout, we should rely on fabricJson.
    // BUT, my `drawOperatorsGrid` here is manual canvas drawing.
    // If the user *edits* the grid in frontend, it is saved as a custom object or as properties?
    // The frontend uses "operatorsGrid" element properties.
    // If fabricJson is present, it means the user saved a custom layout.
    // The previous code had:
    /*
      if (template.fabricJson && template.fabricJson.objects) {
         await drawFabricObjects(template.fabricJson.objects);
         return canvas.toBuffer("image/png");
      }
      */
    // I should restore this capability to support the "Editor" part of the request.
    // I'll add the helper function `drawFabricObjects` and the check at the end.
    // UNLESS the user wants the ability to edit specific elements while keeping others default?
    // Typically, once you save in editor, you get a full fabricJson.
    // So I'll add the fabric drawing helper and check at the end (or beginning of fallback).
    // Wait, if I draw manual canvas calls FIRST, and then check fabricJson, do I overwrite?
    // If fabricJson exists, we should probably output THAT instead of the manual drawing.
    // So I'll add the block for fabricJson.
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

function fillDynamicText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  baseFontSize: number,
  bold: boolean = true,
) {
  let fontSize = baseFontSize;
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
  let textWidth = ctx.measureText(text).width;

  while (textWidth > maxWidth && fontSize > 20) {
    fontSize -= 2;
    ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
    textWidth = ctx.measureText(text).width;
  }

  ctx.fillText(text, x, y, maxWidth);
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
    // Smart split: split by spaces for Western text, but keep CJK chars as individual units
    const words =
      para.match(/[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]|\S+/g) || [];
    let line = "";

    for (let n = 0; n < words.length; n++) {
      let testLine = line + (line === "" ? "" : " ") + words[n];
      // If it's a CJK char, we don't want the space prefix if the previous was also CJK or empty
      if (
        /[\u4e00-\u9fa5]/.test(words[n]) &&
        (line === "" || /[\u4e00-\u9fa5]/.test(line.slice(-1)))
      ) {
        testLine = line + words[n];
      }

      let metrics = ctx.measureText(testLine);
      let testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        if (maxHeight > 0 && testY + lineHeight - y > maxHeight) {
          ctx.fillText(line + "...", x, testY);
          return testY;
        }
        ctx.fillText(line, x, testY);
        line = words[n];
        testY += lineHeight;
      } else {
        line = testLine;
      }
    }

    if (maxHeight > 0 && testY + lineHeight - y > maxHeight) {
      ctx.fillText(line + "...", x, testY);
      return testY;
    }

    ctx.fillText(line, x, testY);
    testY += lineHeight;
  }
  return testY;
}

export async function drawCharacterDetail(
  char: any,
  tr: any,
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
    (Number(char.evolvePhase) || 0) > 0
      ? `phase/${char.evolvePhase}.png`
      : null,
    (Number(char.evolvePhase) || 0) > 0 ? "phase/bg.png" : null,
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

  if (tr.lang === "en") {
    // 1. Level display first to calculate available space for name
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

    // --- English Phase Indicator ---
    const phase = Number(char.evolvePhase) || 0;
    if (phase > 0) {
      try {
        const phaseBg = await loadLocalImage("phase/bg.png");
        const phaseNum = await loadLocalImage(`phase/${phase}.png`);
        const phaseSize = 120;
        const phaseX = startX + numW / 2 - phaseSize / 2;
        const phaseY = infoY + 65;
        ctx.drawImage(phaseBg, phaseX, phaseY, phaseSize, phaseSize);
        const numSize = phaseSize * (204 / 336);
        const numX = phaseX + (phaseSize - numSize) / 2;
        const numY = phaseY + (phaseSize - numSize) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(
          numX + numSize / 2,
          numY + numSize / 2,
          numSize / 2,
          0,
          Math.PI * 2,
        );
        ctx.clip();
        ctx.drawImage(phaseNum, numX, numY, numSize, numSize);
        ctx.restore();
      } catch (e) {}
    }

    // 2. Name + Stars (Width limited by Level text)
    ctx.fillStyle = "#000000";
    const nameMaxWidth = startX - padding - 20;
    fillDynamicText(
      ctx,
      char.charData.name,
      padding,
      infoY + 60,
      nameMaxWidth,
      80,
    );

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
  } else {
    // Original Chinese Layout: Name First
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

    // Level Display (Original behavior)
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

    // 菁英化顯示 (Phase Indicator) - 1.png + bg.png (Refined v2)
    const phase = Number(char.evolvePhase) || 0;
    if (phase > 0) {
      try {
        const phaseBg = await loadLocalImage("phase/bg.png");
        const phaseNum = await loadLocalImage(`phase/${phase}.png`);

        const phaseSize = 120; // Increased size as requested
        // Align center with the level number center
        const phaseX = startX + numW / 2 - phaseSize / 2;
        const phaseY = infoY + 65; // Slightly adjusted for better alignment with larger size

        // Draw background
        ctx.drawImage(phaseBg, phaseX, phaseY, phaseSize, phaseSize);

        // Draw number with circle clip (Proportional to 204/336)
        const numSize = phaseSize * (204 / 336);
        const numX = phaseX + (phaseSize - numSize) / 2;
        const numY = phaseY + (phaseSize - numSize) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.arc(
          numX + numSize / 2,
          numY + numSize / 2,
          numSize / 2,
          0,
          Math.PI * 2,
        );
        ctx.clip();
        ctx.drawImage(phaseNum, numX, numY, numSize, numSize);
        ctx.restore();
      } catch (e) {}
    }
  }

  // Row 2: Icons
  const row2Y = infoY + 160; // Reverted to original position
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
    const ownDate = moment(parseInt(char.ownTs) * 1000).format(
      tr("Year") === "年" ? "YYYY/MM/DD" : "MM/DD/YYYY",
    );
    ctx.fillStyle = "#888";
    ctx.font = "24px NotoSans";
    ctx.fillText(
      `${tr("canvas_JoinedDate")} ${ownDate}`,
      padding - 40,
      height - 20,
    );
  }

  // --- RIGHT SECTION ---
  const skillsY = 80;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText(`I ${tr("canvas_Skills")}`, rightX, skillsY);

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
    const rankLabel = tr("canvas_Rank");
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
    const skName = (s?.name || tr("None"))
      .replace(/，/g, ", ")
      .replace(/。/g, ". ")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/？/g, "?")
      .replace(/！/g, "!");

    ctx.fillStyle = "#222";
    ctx.textAlign = "center";
    ctx.font = "bold 24px NotoSansTCBold";
    wrapText(
      ctx,
      skName,
      sx + skSize / 2,
      skY + skSize + 85,
      skSize + 110,
      30,
      80, // Max height for skill name area
    );
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

  /**
   * Universal helper for rendering Equipment and Tactical items
   */
  async function drawEquipCard(
    e: any,
    ex: number,
    ey: number,
    cardW: number,
    cardH: number,
    hideSkill = false,
  ) {
    ctx.fillStyle = "#fcfcfc";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 8;
    roundRect(ctx, ex, ey, cardW, cardH, 15, true);
    ctx.shadowBlur = 0;

    if (!e.item) {
      drawPlaceholder(ex, ey, cardW, cardH);
      return;
    }

    const data = e.isTac ? e.item.tacticalItemData : e.item.equipData;
    const rKey = data?.rarity?.key || "";
    const rarityColor = getRarityColor(rKey);
    const isTac = !!e.isTac;

    // Rarity indicator
    ctx.fillStyle = rarityColor;
    ctx.fillRect(ex, ey, 12, cardH);

    // 1. Level / Title Section
    ctx.fillStyle = "#111";
    if (isTac) {
      ctx.font = "bold 32px NotoSansTCBold";
      ctx.fillText(data?.name || "??", ex + 35, ey + 50);
    } else {
      ctx.font = "bold 44px NotoSansTCBold";
      const lvVal = data?.level?.value || "??";
      ctx.fillText(`${lvVal}`, ex + 35, ey + 60);
      const lvW = ctx.measureText(lvVal).width;
      ctx.font = "18px NotoSans";
      ctx.fillText("LEVEL", ex + 35 + lvW + 10, ey + 60);
    }

    // 2. Stars
    const rarityNum = parseInt(rKey.split("_").pop() || "0");
    const starSize = isTac ? 22 : 28;
    const starY = ey + (isTac ? 65 : 75);
    for (let j = 0; j < rarityNum; j++) {
      ctx.drawImage(
        starImg,
        ex + 35 + j * (starSize + 4),
        starY,
        starSize,
        starSize,
      );
    }

    // 3. Skill / Effect Description
    const skillY = ey + (isTac ? 120 : 130);
    const nameY = ey + cardH - 25;
    const effectStr = isTac
      ? parseEffectString(data?.activeEffect, data?.activeEffectParams)
      : data?.suit?.skillDesc
        ? parseEffectString(data.suit.skillDesc, data.suit.skillDescParams)
        : "";

    if (effectStr && !hideSkill) {
      const skillFontSize = tr.lang === "en" ? 18 : 20;
      const skillLineH = tr.lang === "en" ? 22 : 28;
      const skillMaxW = tr.lang === "en" ? cardW - 180 : cardW - 140;
      // Tactical items can use more depth since they have no tags at bottom
      const maxH = isTac ? cardH - skillY - 15 : nameY - 50 - skillY;

      ctx.fillStyle = "#666";
      ctx.font = `${skillFontSize}px NotoSansTCBold`;
      wrapText(ctx, effectStr, ex + 30, skillY, skillMaxW, skillLineH, maxH);
    }

    if (isTac) {
      // Tactical items don't have tags/suits at the bottom in current design
    } else {
      // 4. Multi-item Perfection Row: Name + Suit + Tags
      const props = data?.properties || [];
      const suitName = data?.suit?.name;
      const tagFontSize = tr.lang === "en" ? 14 : 22; // Shrunk EN tags slightly more
      const rowCenterY = nameY - 12;
      const nudge = tr.lang === "en" ? 0 : 2;

      // 4a. Calculate Tags total width (Priority 1)
      ctx.font = `bold ${tagFontSize}px NotoSansTCBold`;
      const textPadding = tr.lang === "en" ? 6 : 16;
      const tagGap = 6;

      const tagWidths: number[] = [];
      let totalTagsW = 0;
      const displayedProps = [...props].slice(0, 3);

      displayedProps.forEach((pKey: string) => {
        const enumItem = enums.find((v: any) => v.key === pKey);
        const labelText = enumItem?.value || pKey.replace("equip_attr_", "");
        const tW = ctx.measureText(labelText).width + textPadding;
        tagWidths.push(tW);
        totalTagsW += tW + tagGap;
      });

      // 4b. Calculate available space for Name + Suit
      const suitPillW = suitName
        ? ctx.measureText(suitName).width + (tr.lang === "en" ? 10 : 20)
        : 0;
      const spaceForNameAndSuit = cardW - totalTagsW - 35 - 30 - 15;
      const nameMaxWidth =
        spaceForNameAndSuit - (suitPillW > 0 ? suitPillW + 8 : 0);

      const nameStr = data?.name || tr("None");
      const baseNameSize = tr.lang === "en" ? 30 : 32;

      // 4c. Render Tags (Right to Left)
      let currentRightX = ex + cardW - 30;
      ctx.textBaseline = "middle";
      [...displayedProps].reverse().forEach((pKey, i) => {
        const enumItem = enums.find((v: any) => v.key === pKey);
        const labelText = enumItem?.value || pKey.replace("equip_attr_", "");
        const bgW = tagWidths[displayedProps.length - 1 - i];
        const labelX = currentRightX - bgW;

        ctx.fillStyle = "rgba(0,0,0,0.05)";
        roundRect(ctx, labelX, rowCenterY - 20 + nudge, bgW, 40, 6, true);
        ctx.fillStyle = "#555";
        ctx.textAlign = "center";
        ctx.fillText(labelText, labelX + bgW / 2, rowCenterY + nudge);
        ctx.textAlign = "left";
        currentRightX -= bgW + tagGap;
      });

      // 4d. Render Name & Suit (scaled to fit)
      ctx.fillStyle = "#111";
      fillDynamicText(
        ctx,
        nameStr,
        ex + 35,
        rowCenterY + nudge,
        nameMaxWidth,
        baseNameSize,
      );

      ctx.font = `bold ${baseNameSize}px NotoSansTCBold`;
      const actualNameW = ctx.measureText(nameStr).width;
      const actualDisplayedNameW = Math.min(actualNameW, nameMaxWidth);

      if (suitName) {
        const suitX = ex + 35 + actualDisplayedNameW + 8;
        ctx.font = `bold ${tagFontSize}px NotoSansTCBold`;
        ctx.fillStyle = rarityColor;
        roundRect(ctx, suitX, rowCenterY - 20 + nudge, suitPillW, 40, 6, true);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(suitName, suitX + suitPillW / 2, rowCenterY + nudge);
        ctx.textAlign = "left";
      }
      ctx.textBaseline = "alphabetic";
    }

    // 5. Icon
    if (data?.iconUrl) {
      try {
        const eImg = await fetchImage(data.iconUrl);
        const iconSize = isTac ? 140 : 150;
        ctx.drawImage(
          eImg,
          ex + cardW - (iconSize + 10),
          ey + 10,
          iconSize,
          iconSize,
        );
      } catch (err) {}
    }
  }

  const weaponTitleY = 400;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText(`I ${tr("canvas_Weapons")}`, rightX, weaponTitleY);

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
    ctx.fillText(wd.name || tr("None"), rightX + 45, wCardY + 160);

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
  ctx.fillText(`I ${tr("canvas_Equipment")}`, rightX, gridTitleY);

  const egX = rightX;
  const egY = gridTitleY + 30;
  const totalGridH = height - egY - 60;
  const colW1 = (rightW - eGap) / 2;
  const colW2 = colW1;
  const itemH_L = (totalGridH - eGap) / 2;
  const itemH_R = (totalGridH - 2 * eGap) / 3;

  const leftItems = [
    { item: char.bodyEquip, type: tr("canvas_Armor") },
    { item: char.armEquip, type: tr("canvas_Bracer") },
  ];
  const rightItems = [
    {
      item: char.firstAccessory,
      type: tr("canvas_Accessory"),
      hideSkill: true,
    },
    {
      item: char.secondAccessory,
      type: tr("canvas_Accessory"),
      hideSkill: true,
    },
    { item: char.tacticalItem, type: tr("canvas_TacticalItem"), isTac: true },
  ];

  // Draw Left Column
  for (let i = 0; i < leftItems.length; i++) {
    const e = leftItems[i];
    const ex = egX;
    const ey = egY + i * (itemH_L + eGap);
    await drawEquipCard(e, ex, ey, colW1, itemH_L);
  }

  // Draw Right Column
  for (let i = 0; i < rightItems.length; i++) {
    const e = rightItems[i];
    const ex = egX + colW1 + eGap;
    const ey = egY + i * (itemH_R + eGap);
    await drawEquipCard(e, ex, ey, colW2, itemH_R, e.hideSkill);
  }

  return canvas.toBuffer("image/png");
}
