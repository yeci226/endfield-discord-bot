import {
  createCanvas,
  loadImage,
  GlobalFonts,
  SKRSContext2D,
  Image,
  Path2D,
} from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import axios from "axios";
import { CardDetail } from "./skportApi";
import { ProfileTemplate } from "../interfaces/ProfileTemplate";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
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
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-500.woff2"),
  "NotoSansLatin",
);
GlobalFonts.registerFromPath(
  path.join(fontDir, "Orbitron-400.ttf"),
  "Orbitron",
);
GlobalFonts.registerFromPath(
  path.join(fontDir, "Orbitron-700.ttf"),
  "OrbitronBold",
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
    const bgUrl = template.background?.url;
    if (bgUrl) {
      const bg = bgUrl.startsWith("http")
        ? await fetchImage(bgUrl).catch(() => null)
        : await loadLocalImage(bgUrl).catch(() => null);

      if (bg) {
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
          const scale = template.background.scale;
          drawW = bg.width * scale;
          drawH = bg.height * scale;
          const bgX = template.background.x || 0;
          const bgY = template.background.y || 0;
          offsetX = bgX - drawW / 2;
          offsetY = bgY - drawH / 2;
          ctx.drawImage(bg, offsetX, offsetY, drawW, drawH);
        } else {
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
        }
      } else {
        throw new Error("Failed to load background image");
      }
    } else {
      throw new Error("No background URL provided");
    }
  } catch (e) {
    ctx.fillStyle = template.background?.fillColor || "#1e1e1e";
    ctx.fillRect(0, 0, width, height);
  }

  // Overlay
  if (template.background.overlay !== undefined) {
    let alpha = 0;
    if (typeof template.background.overlay === "number") {
      alpha = template.background.overlay;
    } else if (typeof template.background.overlay === "string") {
      if (template.background.overlay.includes("rgba")) {
        const match = template.background.overlay.match(
          /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/,
        );
        if (match) alpha = parseFloat(match[1]);
        else alpha = 0.3;
      } else {
        alpha = parseFloat(template.background.overlay);
      }
    }

    if (!isNaN(alpha) && alpha > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  const hasFabric = !!(
    template.fabricJson &&
    template.fabricJson.objects &&
    template.fabricJson.objects.length > 0
  );
  const skipIfFabric = (key: string) => {
    if (!hasFabric) return false;
    try {
      const fabric =
        typeof template.fabricJson === "string"
          ? JSON.parse(template.fabricJson)
          : template.fabricJson;
      const objs = fabric.objects;
      if (!objs || !Array.isArray(objs)) return false;

      // Section to Sub-key Mapping
      // If any of these sub-keys exist, we skip the whole hardcoded section.
      const sectionMapping: Record<string, string[]> = {
        avatar: ["avatar"],
        name: ["name"],
        badge: ["badge"],
        statsGrid: [
          "statsGrid",
          "stat_worldLevel",
          "stat_charNum",
          "stat_weaponNum",
          "stat_docNum",
        ],
        missionBox: [
          "missionBox",
          "mission_bg",
          "mission_content",
          "mission_title",
        ],
        authLevelBox: ["authLevelBox", "auth_bg", "auth_val", "auth_label"],
        realtimeTitle: ["realtimeTitle", "realtime_text", "title_text"],
        // NOTE: staminaBox and operatorsGrid are intentionally NOT listed here.
        // Their rendering is too complex (dynamic dot, recovery pill, white card bg, avatars, etc.)
        // for drawFabricObjects to reproduce, so we always use hardcoded rendering.
        activityBpBox: [
          "activityBpBox",
          "activity_bg",
          "act_daily_val",
          "act_bp_val",
        ],
        operatorsTitle: ["operatorsTitle", "operators_title"],
      };

      const keysToSearch = sectionMapping[key] || [key];

      const findInObjects = (items: any[]): boolean => {
        for (const it of items) {
          const itKey = it.data?.key || it.data?.id || it.name;
          if (keysToSearch.includes(itKey)) return true;
          if (it.type === "group" && it.objects) {
            if (findInObjects(it.objects)) return true;
          }
        }
        return false;
      };
      return findInObjects(objs);
    } catch (e) {
      return false;
    }
  };

  // Header (Avatar + Info)
  if (el.avatar.visible && !skipIfFabric("avatar")) {
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
  if (el.name.visible && !skipIfFabric("name")) {
    ctx.fillStyle = el.name.color || "#ffffff";
    const nameMaxW = width - el.name.x - padding; // Approximate
    ctx.font = `${el.name.bold !== false ? "bold " : ""}${el.name.fontSize || 80}px NotoSans`;
    ctx.fillText(
      replacePlaceholders(base.name, {
        base,
        dungeon: detail.dungeon,
        dailyMission: detail.dailyMission,
        bpSystem: detail.bpSystem,
      }),
      el.name.x,
      el.name.y + (el.name.fontSize || 80),
    );
  }

  // Badge / Info Text
  if (el.badge.visible && !skipIfFabric("badge")) {
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
        el.badge.y + (el.badge.fontSize || 32),
        infoMaxW,
        el.badge.fontSize || 32,
        detail,
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
      ctx.fillText(
        replacePlaceholders(`${badgeText} | ${base.serverName}`, {
          base,
          dungeon: detail.dungeon,
          dailyMission: detail.dailyMission,
          bpSystem: detail.bpSystem,
        }),
        el.badge.x,
        el.badge.y + (el.badge.fontSize || 36),
      );
    }
  }

  // 3. Stats Grid
  if (el.statsGrid.visible && !skipIfFabric("statsGrid")) {
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
      ctx.font = "56px NotoSansTCBold";
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
  if (el.missionBox.visible && !skipIfFabric("missionBox")) {
    const mlY = el.missionBox.y;
    const mlH = el.missionBox.height || 160;
    const missionW = el.missionBox.width || 1558;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, el.missionBox.x, mlY, missionW, mlH, 20, true);

    if (base.mainMission) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "60px NotoSansTCBold";
      ctx.textAlign = "left";
      ctx.fillText(
        replacePlaceholders(base.mainMission.description, {
          base,
          dungeon: detail.dungeon,
          dailyMission: detail.dailyMission,
          bpSystem: detail.bpSystem,
        }),
        el.missionBox.x + 40,
        mlY + 30 + 60, // Original baseline logic
      );
      ctx.fillStyle = "#aaaaaa";
      ctx.font = "32px NotoSans";
      ctx.fillText(
        tr("canvas_MainMission"),
        el.missionBox.x + 40,
        mlY + 100 + 32,
      );
    }
  }

  // Level Box
  if (el.authLevelBox.visible && !skipIfFabric("authLevelBox")) {
    const authX = el.authLevelBox.x;
    const authY = el.authLevelBox.y;
    const authW = el.authLevelBox.width || 662;
    const authH = el.authLevelBox.height || 160;

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, authX, authY, authW, authH, 20, true);

    ctx.fillStyle = "#ffffff";
    ctx.font = "80px NotoSansTCBold";
    ctx.textAlign = "center";
    ctx.fillText(
      replacePlaceholders(base.level.toString(), {
        base,
        dungeon: detail.dungeon,
        dailyMission: detail.dailyMission,
        bpSystem: detail.bpSystem,
      }),
      authX + authW / 2,
      authY + 25 + 80,
    );
    ctx.fillStyle = "#aaaaaa";
    ctx.font = "32px NotoSans";
    ctx.fillText(tr("canvas_AuthLevel"), authX + authW / 2, authY + 105 + 32);
    ctx.textAlign = "left";
  }

  // 4. Real-time Data Title
  if (el.realtimeTitle.visible && !skipIfFabric("realtimeTitle")) {
    const rtY = el.realtimeTitle.y;
    const rtX = el.realtimeTitle.x; // 150

    ctx.save();
    if (el.realtimeTitle.angle)
      ctx.rotate((el.realtimeTitle.angle * Math.PI) / 180);
    if (el.realtimeTitle.scaleX || el.realtimeTitle.scaleY)
      ctx.scale(el.realtimeTitle.scaleX || 1, el.realtimeTitle.scaleY || 1);

    // Default style based on original
    ctx.fillStyle = "#ffffff";
    ctx.font = `${el.realtimeTitle.fontSize || 50}px NotoSansTCBold`;
    const decorX = rtX;

    // Editor: group is at X, text at group + 70
    ctx.fillText(tr("canvas_RealtimeData"), rtX + 70, rtY + 40);

    // Rects aligned with editor's group local [0, 20, 40]
    ctx.fillRect(decorX, rtY + 10, 12, 35);
    ctx.fillRect(decorX + 20, rtY - 5, 12, 50);
    ctx.fillRect(decorX + 40, rtY + 15, 12, 25);
    ctx.restore();
  }

  const { dungeon, dailyMission, weeklyMission, bpSystem } = detail;

  // Stamina Box (Left)
  if (el.staminaBox.visible && dungeon && !skipIfFabric("staminaBox")) {
    const staX = el.staminaBox.x;
    const staY = el.staminaBox.y;
    const staW = el.staminaBox.width || 750;
    const staH = el.staminaBox.height || 180;

    ctx.save();
    if (el.staminaBox.angle) ctx.rotate((el.staminaBox.angle * Math.PI) / 180);
    if (el.staminaBox.scaleX || el.staminaBox.scaleY)
      ctx.scale(el.staminaBox.scaleX || 1, el.staminaBox.scaleY || 1);

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, staX, staY, staW, staH, 20, true);

    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "75px NotoSansTCBold"; // Editor uses 75
    const curStamina = replacePlaceholders(dungeon.curStamina.toString(), {
      base,
      dungeon: detail.dungeon,
      dailyMission: detail.dailyMission,
      bpSystem: detail.bpSystem,
    });
    ctx.fillText(curStamina, staX + 40, staY + 25 + 75);
    // Editor uses a fixed offset of 75 for the "/" part
    const slashX = staX + 40 + 75 + 15;
    ctx.fillStyle = "#666666"; // Editor uses #666
    ctx.font = "36px NotoSans";
    ctx.fillText(`/ ${dungeon.maxStamina}`, slashX, staY + 55 + 36);

    // Recovery Time Logics
    const now = Math.floor(Date.now() / 1000);
    const maxTs = parseInt(dungeon.maxTs);
    let recoveryText = "未獲取到恢復時間";
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
    const dotR = 8;
    const dotGap = 12;
    const pillPaddingX = 20;
    const pillPaddingY = 12;
    const maxPillW = staW * 0.55; // Cap pill width to ~55% of stamina box

    let pillFontSize = 30;
    ctx.font = `${pillFontSize}px NotoSans`;
    let recTextW = ctx.measureText(recoveryText).width;
    let pillW = pillPaddingX * 2 + dotR * 2 + dotGap + recTextW;

    // Shrink font if pill overflows
    while (pillW > maxPillW && pillFontSize > 18) {
      pillFontSize -= 2;
      ctx.font = `${pillFontSize}px NotoSans`;
      recTextW = ctx.measureText(recoveryText).width;
      pillW = pillPaddingX * 2 + dotR * 2 + dotGap + recTextW;
    }

    const pillH = pillFontSize + pillPaddingY * 2;

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
    ctx.font = `${pillFontSize}px NotoSans`;
    ctx.fillText(
      recoveryText,
      dotX + dotR + dotGap,
      pillY + pillH / 2 + Math.round(pillFontSize / 3),
    );

    // Labels
    ctx.textAlign = "left";
    ctx.fillStyle = "#888888"; // Editor uses #888
    ctx.font = "24px NotoSans";
    ctx.fillText(tr("canvas_Stamina"), staX + 40, staY + 110 + 24);
    ctx.textAlign = "right";
    ctx.fillText(tr("canvas_RecoveryTime"), staX + staW - 30, staY + 110 + 24);
    ctx.textAlign = "left";
    ctx.restore();
  }

  // Activity Box (Right) — 3-column: number on top, label below
  if (el.activityBpBox.visible && !skipIfFabric("activityBpBox")) {
    const actX = el.activityBpBox.x;
    const actY = el.activityBpBox.y;
    const actW = el.activityBpBox.width || 1450;
    const actH = el.activityBpBox.height || 180;

    ctx.save();
    if (el.activityBpBox.angle)
      ctx.rotate((el.activityBpBox.angle * Math.PI) / 180);
    if (el.activityBpBox.scaleX || el.activityBpBox.scaleY)
      ctx.scale(el.activityBpBox.scaleX || 1, el.activityBpBox.scaleY || 1);

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, actX, actY, actW, actH, 20, true);

    const cols: { label: string; value: string }[] = [];
    if (dailyMission)
      cols.push({
        label: tr("canvas_Activity"),
        value: `${dailyMission.dailyActivation}/${dailyMission.maxDailyActivation}`,
      });
    if (weeklyMission)
      cols.push({
        label: tr("canvas_WeeklyMission"),
        value: `${weeklyMission.score}/${weeklyMission.total}`,
      });
    if (bpSystem)
      cols.push({
        label: tr("canvas_BP"),
        value: `${bpSystem.curLevel}/${bpSystem.maxLevel}`,
      });

    const colW = cols.length > 0 ? actW / cols.length : actW;
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const colCenterX = actX + colW * i + colW / 2;

      // Vertical divider (not before first col)
      if (i > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(actX + colW * i, actY + 20, 1, actH - 40);
      }

      // Value (top, bold, white)
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.font = "60px NotoSansTCBold";
      ctx.fillText(col.value, colCenterX, actY + 35 + 60);

      // Label (below, gray)
      ctx.fillStyle = "#888888";
      ctx.font = "28px NotoSans";
      ctx.fillText(col.label, colCenterX, actY + 100 + 28);
    }

    ctx.textAlign = "left";
    ctx.restore();
  }

  // Achieve Section (光榮之路)
  if (
    el.achieveTitle?.visible &&
    detail.achieve &&
    !skipIfFabric("achieveTitle")
  ) {
    const rtX = el.achieveTitle.x;
    const rtY = el.achieveTitle.y;
    const decorX = rtX;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.font = `${el.achieveTitle.fontSize || 50}px NotoSansTCBold`;
    ctx.fillText(tr("canvas_AchieveTitle"), rtX + 70, rtY + 40);

    // Replace 3 vertical bars with Hexagon
    drawStylizedHexagon(
      ctx,
      rtX + 25,
      rtY + 15,
      25,
      "rgba(255,255,255,0.2)",
      "#ffffff",
    );
    ctx.restore();
  }

  if (el.achieveBox?.visible && detail.achieve && !skipIfFabric("achieveBox")) {
    const achieve = detail.achieve;
    const axX = el.achieveBox.x;
    const axY = el.achieveBox.y;
    const axW = el.achieveBox.width || 2240;
    const axH = el.achieveBox.height || 300;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    roundRect(ctx, axX, axY, axW, axH, 20, true);
    ctx.restore();

    // Build medal lookup map
    const medalMap = new Map<string, (typeof achieve.achieveMedals)[number]>();
    (achieve.achieveMedals || []).forEach((m) =>
      medalMap.set(m.achievementData.id, m),
    );

    // Count by initLevel tier (1=bronze, 2=silver, 3=gold)
    const tierCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    (achieve.achieveMedals || []).forEach((m) => {
      const t = m.achievementData.initLevel;
      if (tierCounts[t] !== undefined) tierCounts[t]++;
    });

    const sidePad = 50;
    const leftW = Math.round(axW * 0.28);

    // ── LEFT: stats ──
    ctx.save();
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "100px NotoSansTCBold";
    ctx.fillText(String(achieve.count), axX + sidePad, axY + sidePad + 100);

    ctx.fillStyle = "#888888";
    ctx.font = "28px NotoSans";
    ctx.fillText(
      tr("canvas_TotalCollected"),
      axX + sidePad,
      axY + sidePad + 100 + 40,
    );

    // Tier icons + counts (bottom of left area)
    const tierIconSize = 40;
    const tierY = axY + axH - sidePad - tierIconSize;
    let tierX = axX + sidePad;

    const tierBgColors = ["#3d3d3d", "#e0e0e0", "#f4e05d"];
    const tierLineColors = ["#aaaaaa", "#666666", "#7c6f2b"];

    for (let t = 0; t < 3; t++) {
      // Draw custom hexagon instead of rank images
      drawStylizedHexagon(
        ctx,
        tierX + tierIconSize / 2,
        tierY + tierIconSize / 2,
        tierIconSize / 2,
        tierBgColors[t],
        tierLineColors[t],
      );

      tierX += tierIconSize + 15;
      ctx.fillStyle = "#cccccc";
      ctx.font = "34px NotoSansTCBold";
      ctx.fillText(
        String(tierCounts[t + 1] ?? 0),
        tierX,
        tierY + tierIconSize - 2,
      );
      tierX += ctx.measureText(String(tierCounts[t + 1] ?? 0)).width + 30;
    }
    ctx.restore();

    // ── RIGHT: rotated bg hex grid + 3×2 flat-top display medals ──
    // Flat-top hex: vertices at 0°,60°,120°,180°,240°,300°
    // Zero-gap tiling: colSpacing=1.5r, rowSpacing=r*√3, odd cols stagger down r*√3/2
    // Total 3×2 grid: width=5r, height=2.5*r*√3
    const hexAreaX = axX + leftW;
    const hexAreaW = axW - leftW;

    // pointy-top honeycomb (edge-to-edge): colSpacing=√3r, rowSpacing=1.5r
    // 5 cols × 2 rows, row-stagger (row1 shifts right by √3r/2)
    // bounding box: width=5.5√3r, height=3.5r
    const hexR = Math.max(
      Math.floor(Math.min(axH / 3.5, hexAreaW / (5.5 * Math.sqrt(3)))),
      1,
    );
    const hexColSpacing = hexR * Math.sqrt(3);
    const hexRowSpacing = hexR * 1.5;

    // Center grid: overall x span is [-√3r/2, 5√3r] = 5.5√3r wide
    const gridStartX =
      hexAreaX +
      (hexAreaW - 5.5 * hexR * Math.sqrt(3)) / 2 +
      (hexR * Math.sqrt(3)) / 2;
    const gridStartY = axY + hexR; // top vertex = axY

    // column-major: col=floor((slot-1)/2), row=(slot-1)%2
    // row1 shifts right by √3r/2 to form proper honeycomb edge-sharing
    for (let slot = 1; slot <= 10; slot++) {
      const col = Math.floor((slot - 1) / 2);
      const row = (slot - 1) % 2;
      const cx =
        gridStartX + col * hexColSpacing + (row === 1 ? hexColSpacing / 2 : 0);
      const cy = gridStartY + row * hexRowSpacing;

      const medalId = achieve.display?.[String(slot)];
      const medal = medalId ? medalMap.get(medalId) : undefined;

      let iconUrl = "";
      if (medal) {
        const { achievementData, level, isPlated } = medal;
        if (isPlated && achievementData.platedIcon)
          iconUrl = achievementData.platedIcon;
        else if (level >= 3 && achievementData.reforge3Icon)
          iconUrl = achievementData.reforge3Icon;
        else if (level >= 2 && achievementData.reforge2Icon)
          iconUrl = achievementData.reforge2Icon;
        else iconUrl = achievementData.initIcon;
      }

      // Build rotated hex path (30°) for this slot
      const drawRotatedHex = () => {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i + (30 * Math.PI) / 180;
          if (i === 0)
            ctx.moveTo(cx + hexR * Math.cos(a), cy + hexR * Math.sin(a));
          else ctx.lineTo(cx + hexR * Math.cos(a), cy + hexR * Math.sin(a));
        }
        ctx.closePath();
      };

      ctx.save();
      drawRotatedHex();
      ctx.save();
      ctx.clip();
      if (medal && iconUrl) {
        let medalImg: any = null;
        try {
          medalImg = await fetchImage(iconUrl);
        } catch {}
        if (medalImg) {
          ctx.drawImage(medalImg, cx - hexR, cy - hexR, hexR * 2, hexR * 2);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.2)";
          ctx.fill();
        }
        // stroke inside clip → image fills flush to border
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 4;
        drawRotatedHex();
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 2;
        drawRotatedHex();
        ctx.stroke();
      }
      ctx.restore(); // remove clip
      ctx.restore(); // restore outer
    }
  }

  // Operators Title
  if (el.operatorsTitle.visible && !skipIfFabric("operatorsTitle")) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.font = `${el.operatorsTitle.fontSize || 50}px NotoSansTCBold`;
    // Align with editor's NotoSansTC (default is centered or relative to group)
    // In editor, operators title is just a text at x, y
    ctx.fillText(
      tr("canvas_Operators"),
      el.operatorsTitle.x,
      el.operatorsTitle.y + (el.operatorsTitle.fontSize || 50), // Approx baseline
    );
    ctx.restore();
  }

  // Operators Grid
  if (el.operatorsGrid.visible && !skipIfFabric("operatorsGrid")) {
    const gridX = el.operatorsGrid.x;
    const gridY = el.operatorsGrid.y;

    ctx.save();
    if (el.operatorsGrid.angle)
      ctx.rotate((el.operatorsGrid.angle * Math.PI) / 180);
    if (el.operatorsGrid.scaleX || el.operatorsGrid.scaleY)
      ctx.scale(el.operatorsGrid.scaleX || 1, el.operatorsGrid.scaleY || 1);

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
      loadLocalImage(`phase/${phase}.png`).catch(() => {});
      loadLocalImage("phase/bg.png").catch(() => {});
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
        
        const phaseVal = char.evolvePhase !== undefined ? char.evolvePhase : 0;
        phaseImg = await loadLocalImage(`phase/${phaseVal}.png`);

        // Preload rank icon
        loadLocalImage(`rank/${char.potentialLevel ?? 0}.png`).catch(() => {});
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

      ctx.font = "28px NotoSansTCBold";
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

      // Phase + Rank pill (bottom-right)
      {
        const phase = char.evolvePhase ?? 0;
        const iconSize = 28;
        const cellPad = 5;
        const cellW = iconSize + cellPad * 2;
        const containerH = iconSize + cellPad * 2;
        const containerW = cellW * 2 + 2;
        const containerX = x + charImageSize - containerW - 6;
        const containerY = y + charImageSize - containerH - 6;

        ctx.fillStyle = "rgba(30,30,30,0.82)";
        roundRect(ctx, containerX, containerY, containerW, containerH, 8, true);

        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(containerX + cellW, containerY + 4, 2, containerH - 8);

        // Left cell: phase icon
        if (phaseImg) {
          ctx.drawImage(
            phaseImg,
            containerX + cellPad,
            containerY + cellPad,
            iconSize,
            iconSize,
          );
        }

        // Right cell: rank icon
        try {
          const rankImg = await loadLocalImage(
            `rank/${char.potentialLevel ?? 0}.png`,
          );
          ctx.drawImage(
            rankImg,
            containerX + cellW + 2 + cellPad,
            containerY + cellPad,
            iconSize,
            iconSize,
          );
        } catch (_) {}
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
    ctx.restore();
  }

  // Fabric Objects support (for User Edited Stuff)
  if (template.fabricJson && template.fabricJson.objects) {
    await drawFabricObjects(ctx, template.fabricJson.objects);
  }

  return canvas.toBuffer("image/webp", 90);
}

async function drawFabricObjects(
  ctx: SKRSContext2D,
  objects: any[],
  parent: any = null,
) {
  for (const obj of objects) {
    if (obj.visible === false) continue;
    if (obj.data?.key === "system_overlay") continue;

    ctx.save();

    // Fabric.js Group handling:
    // If we are in a group, the coordinates (left, top) of child objects are relative to the group's CENTER.
    const originX = obj.originX || "left";
    const originY = obj.originY || "top";

    ctx.translate(obj.left, obj.top);

    ctx.rotate((obj.angle * Math.PI) / 180);
    ctx.scale(obj.scaleX || 1, obj.scaleY || 1);
    ctx.globalAlpha =
      (obj.opacity !== undefined ? obj.opacity : 1) * (ctx.globalAlpha || 1);

    // Adjust for origins
    let offsetX = 0;
    let offsetY = 0;

    // Correct translation for Fabric.js logic:
    // If it's a child of a group, we are already translated to the object's relative center.
    // If it's a top-level object, left/top is usually the top-left corner UNLESS originX/Y is center.
    if (originX === "center") offsetX = -obj.width / 2;
    if (originY === "center") offsetY = -obj.height / 2;

    // Handle nested scaling and translation for children of groups
    if (parent) {
      // In a group, objects are positioned relative to the center of the group
      // No extra move needed if skipFabric logic is followed correctly,
      // but we must ENSURE we don't double-translate if the origin is already handled.
    }

    switch (obj.type) {
      case "group":
        if (obj.objects) {
          // In Fabric, children of a group are relative to the group's center.
          // Since we translated to obj.left/top, we must check if that was the top-left or center.
          ctx.save();
          if (originX === "left") ctx.translate(obj.width / 2, 0);
          if (originY === "top") ctx.translate(0, obj.height / 2);

          await drawFabricObjects(ctx, obj.objects, obj);
          ctx.restore();
        }
        break;

      case "rect":
        ctx.fillStyle = obj.fill || "transparent";
        if (obj.rx || obj.ry) {
          roundRect(
            ctx,
            offsetX,
            offsetY,
            obj.width,
            obj.height,
            obj.rx || obj.ry,
            true,
          );
        } else {
          ctx.fillRect(offsetX, offsetY, obj.width, obj.height);
        }
        if (obj.stroke && (obj.strokeWidth || 0) > 0) {
          ctx.strokeStyle = obj.stroke;
          ctx.lineWidth = obj.strokeWidth;
          if (obj.rx || obj.ry) {
            roundRect(
              ctx,
              offsetX,
              offsetY,
              obj.width,
              obj.height,
              obj.rx || obj.ry,
              false,
            );
          } else {
            ctx.strokeRect(offsetX, offsetY, obj.width, obj.height);
          }
        }
        break;

      case "text":
      case "i-text":
      case "itext":
      case "textbox":
        ctx.fillStyle = obj.fill || "white";
        // Map common fonts
        let fontFamily = "NotoSans";
        let weightStr = "";

        if (obj.fontFamily?.includes("Orbitron")) {
          if (obj.fontWeight === "bold" || obj.fontWeight > 500) {
            fontFamily = "OrbitronBold";
            weightStr = ""; // Don't add 'bold' if using Bold face
          } else {
            fontFamily = "Orbitron";
          }
        } else if (obj.fontFamily?.includes("Noto Sans TC")) {
          if (obj.fontWeight === "bold" || obj.fontWeight > 500) {
            fontFamily = "NotoSansTCBold";
            weightStr = "";
          } else {
            fontFamily = "NotoSans";
          }
        } else {
          weightStr = obj.fontWeight === "bold" ? "bold " : "";
        }

        ctx.font = `${weightStr}${obj.fontSize}px ${fontFamily}`;
        ctx.textAlign =
          obj.originX === "center"
            ? "center"
            : obj.originX === "right"
              ? "right"
              : "left";
        ctx.textBaseline =
          obj.originY === "center"
            ? "middle"
            : obj.originY === "bottom"
              ? "bottom"
              : "top";

        // Logic fix: Since we already translated to the anchor point (obj.left, obj.top),
        // we draw at (0,0) relative to that anchor.
        // Fabric origin alignment handles the rest.
        const renderedText = replacePlaceholders(
          obj.text || "",
          parent?.data?.detail || {},
        );
        ctx.fillText(renderedText, 0, 0);

        if (obj.stroke && (obj.strokeWidth || 0) > 0) {
          ctx.strokeStyle = obj.stroke;
          ctx.lineWidth = obj.strokeWidth;
          ctx.strokeText(renderedText, 0, 0);
        }
        break;

      case "line":
        ctx.strokeStyle = obj.stroke || "white";
        ctx.lineWidth = obj.strokeWidth || 1;
        ctx.beginPath();
        ctx.moveTo(obj.x1 - obj.width / 2, obj.y1 - obj.height / 2);
        ctx.lineTo(obj.x2 - obj.width / 2, obj.y2 - obj.height / 2);
        ctx.stroke();
        break;

      case "image":
        const imgSrc = obj.src || obj.data?.src;
        if (imgSrc) {
          try {
            const isProxy = imgSrc.includes("/api/proxy?url=");
            let img;
            if (isProxy) {
              const realUrl = decodeURIComponent(imgSrc.split("url=")[1]);
              img = await fetchImage(realUrl);
            } else {
              const imgUrl = imgSrc.startsWith("/")
                ? imgSrc.substring(1)
                : imgSrc;
              img = imgSrc.startsWith("http")
                ? await fetchImage(imgSrc)
                : await loadLocalImage(imgUrl);
            }

            if (img) {
              ctx.drawImage(img, offsetX, offsetY, obj.width, obj.height);
            }
          } catch (e) {}
        }
        break;

        if (obj.path) {
          ctx.save();
          // Logic fix for Operator Cards:
          // Paths (especially complex ones like the card frame) need to be drawn relative to their top-left
          // if originX/Y is top/left, or centered if originX/Y is center.
          // Since we already translated to (obj.left, obj.top), we use offsetX/Y here.
          ctx.translate(offsetX, offsetY);

          ctx.fillStyle = obj.fill || "transparent";
          ctx.strokeStyle = obj.stroke || "transparent";
          ctx.lineWidth = obj.strokeWidth || 0;

          const p = new Path2D(
            obj.path.map((seg: any) => seg.join(" ")).join(" "),
          );
          if (obj.fill && obj.fill !== "transparent") ctx.fill(p);
          if (obj.stroke && obj.stroke !== "transparent") ctx.stroke(p);
          ctx.restore();
        }
        break;
    }

    ctx.restore();
  }
}

async function loadLocalImage(relPath: string) {
  if (imageCache.has(relPath)) return imageCache.get(relPath)!;
  const fullPath = path.join(ASSETS_DIR, relPath);
  if (!fs.existsSync(fullPath)) return null;
  const img = await loadImage(fs.readFileSync(fullPath));
  imageCache.set(relPath, img);
  return img;
}

export async function fetchImage(
  url: string,
  customCacheName?: string,
): Promise<Image> {
  if (imageCache.has(url)) return imageCache.get(url)!;

  const ext = url.split(".").pop()?.split(/[?#]/)[0] || "png";
  const fileName = customCacheName
    ? `${customCacheName}.${ext}`
    : `${crypto.createHash("md5").update(url).digest("hex")}.${ext}`;

  const cachePath = path.join(CACHE_DIR, fileName);

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
    let response;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };

    try {
      response = await axios.get(url, {
        headers,
        responseType: "arraybuffer",
        timeout: 10000,
      });
    } catch (e) {
      // Fallback: If .png fails, try .webp if it's not already webp
      if (url.endsWith(".png")) {
        const webpUrl = url.replace(".png", ".webp");
        response = await axios.get(webpUrl, {
          headers,
          responseType: "arraybuffer",
          timeout: 10000,
        });
      } else {
        throw e;
      }
    }

    const buffer = Buffer.from(response.data);

    // Save to disk cache
    fs.writeFileSync(cachePath, buffer);

    const img = await loadImage(buffer);
    imageCache.set(url, img);
    return img;
  } catch (e: any) {
    console.error(
      `Failed to fetch image: ${url}. Status: ${e.response?.status}. Error: ${e.message}`,
    );
    throw e;
  }
}

function roundRect(
  ctx: SKRSContext2D,
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

function drawStylizedHexagon(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  r: number,
  bgColor: string,
  lineColor: string,
) {
  const drawHex = (radius: number, context: any) => {
    context.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2; // Pointy top
      const px = x + radius * Math.cos(a);
      const py = y + radius * Math.sin(a);
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
  };

  // 1. Draw solid background
  ctx.save();
  ctx.fillStyle = bgColor;
  drawHex(r, ctx);
  ctx.fill();

  // 2. Draw 3 concentric light lines (Endfield style)
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = Math.max(r / 12, 1.5);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // We draw 3 nested hexagon paths, but only the top halves to match the vibe
  for (let i = 1; i <= 3; i++) {
    const innerR = r * (1 - i * 0.22);
    if (innerR > 0) {
      ctx.beginPath();
      // Draw 4 segments out of 6 to create the "stacked" look
      for (let j = 0; j < 4; j++) {
        const a = (Math.PI / 3) * (j + 4) - Math.PI / 2;
        const px = x + innerR * Math.cos(a);
        const py = y + innerR * Math.sin(a);
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}
function parseEffectString(effectStr: string, params: any): string {
  if (!effectStr) return "";
  let res = effectStr;
  // Strip tags like <@ba.vup> or </>
  res = res.replace(/<[^>]+>/g, "");
  // Replace {key:0} or {key} or {1-key:0}
  res = res.replace(/\{([^{}]+)\}/g, (match, content) => {
    // content could be "1-dmg_taken_down2:0%"
    const parts = content.split(":");
    let expr = parts[0]; // "1-dmg_taken_down2"
    const format = parts[1] || ""; // "0%"

    let finalVal: number | string = "";

    if (expr.startsWith("1-")) {
      const key = expr.replace("1-", "");
      let val = params[key];
      if (val === undefined) return match;
      finalVal = 1 - Number(val);
    } else {
      let val = params[expr];
      if (val === undefined) return match;
      finalVal = val;
    }

    // Basic percentage handling if requested in placeholder
    if (format.includes("%") && !isNaN(Number(finalVal))) {
      return (Number(finalVal) * 100).toFixed(0) + "%";
    }
    return String(finalVal);
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

function replacePlaceholders(text: string, detail: any): string {
  if (!text.includes("{")) return text;

  const b = detail.base || {};
  const d = detail.dungeon || {};
  const m = b.mainMission || {};
  const act = detail.dailyMission || {};
  const bp = detail.bpSystem || {};

  const placeholders: Record<string, any> = {
    "{uid}": b.roleId || "",
    "{name}": b.name || "",
    "{server}": b.serverName || "",
    "{exploreLevel}": b.worldLevel || 0,
    "{charNum}": b.charNum || 0,
    "{weaponNum}": b.weaponNum || 0,
    "{docNum}": b.docNum || 0,
    "{staminaCur}": d.curStamina || 0,
    "{staminaMax}": d.maxStamina || 240,
    "{authLevel}": b.level || 1,
    "{mainMission}": m.description || "",
    "{actDaily}": act.dailyActivation || 0,
    "{actDailyMax}": act.maxDailyActivation || 100,
    "{bpLevel}": bp.curLevel || 1,
    "{bpMaxLevel}": bp.maxLevel || 50,
  };

  let result = text;
  for (const [key, val] of Object.entries(placeholders)) {
    result = result.split(key).join(String(val));
  }
  return result;
}

function fillDynamicText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  baseFontSize: number,
  detail: any,
  bold: boolean,
) {
  let fontSize = baseFontSize;
  ctx.font = `${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
  let textWidth = ctx.measureText(text).width;

  while (textWidth > maxWidth && fontSize > 20) {
    fontSize -= 2;
    ctx.font = `${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
    textWidth = ctx.measureText(text).width;
  }

  const oldBaseline = ctx.textBaseline;
  ctx.textBaseline = "top";
  const renderedText = replacePlaceholders(text, detail);
  ctx.fillText(renderedText, x, y, maxWidth);
  ctx.textBaseline = oldBaseline;
}

function wrapText(
  ctx: SKRSContext2D,
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

/** Count how many lines wrapText would produce (without drawing). */
function measureLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): number {
  let count = 0;
  for (const para of text.split("\n")) {
    const words =
      para.match(/[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uff00-\uffef]|\S+/g) || [];
    let line = "";
    for (const word of words) {
      let testLine =
        /[\u4e00-\u9fa5]/.test(word) &&
        (line === "" || /[\u4e00-\u9fa5]/.test(line.slice(-1)))
          ? line + word
          : line + (line === "" ? "" : " ") + word;
      if (ctx.measureText(testLine).width > maxWidth && line !== "") {
        count++;
        line = word;
      } else {
        line = testLine;
      }
    }
    count++;
  }
  return count;
}

export async function drawCharacterDetail(
  char: any,
  tr: any,
  detail: any,
  enums: any[] = [],
  charIndex: number = 1,
): Promise<Buffer> {
  const width = 2400;
  const height = 1500; // Increased height for passiveEffect display
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
  const gemUrl =
    char.weapon?.gem?.gemData?.icon ||
    char.weapon?.gem?.iconUrl ||
    char.weapon?.gem?.icon;

  const talentUrls = [
    ...(char.charData.abilityTalents || []),
    ...(char.charData.combatTalents || []),
    ...(char.charData.cultivationTalents || []),
  ]
    .map((t: any) => t.iconUrl)
    .filter(Boolean);

  const remoteUrls = [
    imgUrl,
    ...skillUrls,
    ...equipUrls,
    weaponUrl,
    gemUrl,
    ...talentUrls,
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
    `phase/${char.evolvePhase ?? 0}.png`,
    "phase/bg.png",
    `rank/${char.potentialLevel ?? 0}.png`,
    `phase/${char.weapon?.breakthroughLevel ?? 0}.png`,
    `rank/${char.weapon?.refineLevel ?? 0}.png`,
    "skill_property/1.png",
    "skill_property/2.png",
    "skill_property/3.png",
    "skill_property/4.png",
    "skill_property/alpha.png",
    "skill_property/beta.png",
    "skill_property/gemma.png",
    "skill_property/bodyEquip.png",
    "skill_property/armEquip.png",
    "skill_property/firstAccessory.png",
    "skill_property/secondAccessory.png",
    "skill_property/tacticalItem.png",
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
    `ENDFIELD INDUSTRIES -- ${charIndex.toString().padStart(2, "0")}`,
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

    // --- Phase + Rank pill container ---
    {
      const phase = Number(char.evolvePhase) || 0;
      const iconSize = 72;
      const cellPad = 14;
      const cellW = iconSize + cellPad * 2;
      const containerH = iconSize + cellPad * 2;
      const containerW = cellW * 2 + 2;
      const containerX = startX;
      const containerY = infoY + 78;

      ctx.fillStyle = "rgba(80,80,80,0.75)";
      roundRect(ctx, containerX, containerY, containerW, containerH, 14, true);

      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(containerX + cellW, containerY + 10, 2, containerH - 20);

      try {
        const phaseNum = await loadLocalImage(`phase/${phase}.png`);
        ctx.drawImage(
          phaseNum,
          containerX + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}

      try {
        const rankImg = await loadLocalImage(
          `rank/${char.potentialLevel ?? 0}.png`,
        );
        ctx.drawImage(
          rankImg,
          containerX + cellW + 2 + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}
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
      detail,
      true,
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

    // --- Phase + Rank pill container ---
    {
      const phase = Number(char.evolvePhase) || 0;
      const iconSize = 72;
      const cellPad = 14;
      const cellW = iconSize + cellPad * 2;
      const containerH = iconSize + cellPad * 2;
      const containerW = cellW * 2 + 2;
      const containerX = startX;
      const containerY = infoY + 78;

      ctx.fillStyle = "rgba(80,80,80,0.75)";
      roundRect(ctx, containerX, containerY, containerW, containerH, 14, true);

      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(containerX + cellW, containerY + 10, 2, containerH - 20);

      try {
        const phaseNum = await loadLocalImage(`phase/${phase}.png`);
        ctx.drawImage(
          phaseNum,
          containerX + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}

      try {
        const rankImg = await loadLocalImage(
          `rank/${char.potentialLevel ?? 0}.png`,
        );
        ctx.drawImage(
          rankImg,
          containerX + cellW + 2 + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}
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

  // Skill bars: 4 horizontal rows
  const skillBarW = 960;
  const barH = 60;
  const barGap = 6;
  const barAreaY = skillsY + 20;
  const sqH = 20; // rectangle height
  const sqGap = 5;
  const sqR = 4; // corner radius
  // 10-12 capsule: fixed 46 × 26 px, placed at right edge of bar
  const capW = 56; // capsule width (enlarged for bigger circles)
  const capPad = 12; // gap between last rect and capsule
  const spotR = 8; // all 3 circles same radius
  const skList = char.charData.skills || [];

  for (let i = 0; i < 4; i++) {
    const s = skList[i];
    const barY = barAreaY + i * (barH + barGap);

    // Bar background
    ctx.fillStyle = "#f8f8f8";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 8;
    roundRect(ctx, rightX, barY, skillBarW, barH, 12, true);
    ctx.shadowBlur = 0;

    // Skill icon circle
    const iconR = 22;
    const iconCX = rightX + 14 + iconR;
    const iconCY = barY + barH / 2;
    ctx.fillStyle = "#dddddd";
    ctx.beginPath();
    ctx.arc(iconCX, iconCY, iconR, 0, Math.PI * 2);
    ctx.fill();
    if (s?.iconUrl) {
      try {
        const sImg = await fetchImage(s.iconUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(iconCX, iconCY, iconR - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(
          sImg,
          iconCX - iconR,
          iconCY - iconR,
          iconR * 2,
          iconR * 2,
        );
        ctx.restore();
      } catch (_) {}
    }
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(iconCX, iconCY, iconR, 0, Math.PI * 2);
    ctx.stroke();

    // Level data (needed before drawing name for RANK text)
    const userSk = char.userSkills?.[s?.id || ""] || { level: 1, maxLevel: 12 };
    const level = userSk.level || 1;

    // Skill name
    const nameX = rightX + 14 + iconR * 2 + 14;
    ctx.fillStyle = "#222";
    ctx.font = "bold 26px NotoSansTCBold";
    ctx.textAlign = "left";
    ctx.fillText(s?.name || tr("None"), nameX, barY + 28);

    // RANK X/Y — vertically centred with the level rectangles
    ctx.font = "bold 26px NotoSansTCBold";
    const nameTextW = ctx.measureText(s?.name || "").width;
    const rankLabel = tr("canvas_Rank");
    const rankNum = `${level}`;
    const rankMax = `/${userSk.maxLevel}`;
    const rankGapX = nameX + nameTextW + 16;
    const rankBaseY = barY + barH / 2 + 7; // baseline aligned with rect vertical centre
    ctx.font = "bold 16px NotoSans";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText(rankLabel, rankGapX, rankBaseY);
    const rankLabelW = ctx.measureText(rankLabel).width;
    ctx.font = "bold 22px NotoSans";
    ctx.fillStyle = "#555";
    ctx.fillText(rankNum, rankGapX + rankLabelW + 6, rankBaseY);
    const rankNumW = ctx.measureText(rankNum).width;
    ctx.font = "16px NotoSans";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText(rankMax, rankGapX + rankLabelW + 6 + rankNumW, rankBaseY);
    const rankMaxW = ctx.measureText(rankMax).width;
    const rankTotalW = rankLabelW + 6 + rankNumW + rankMaxW;

    // Skill type label
    if (s?.type?.value) {
      ctx.fillStyle = "#999";
      ctx.font = "18px NotoSans";
      ctx.fillText(s.type.value, nameX, barY + 52);
    }

    // Measure type text for sqStart
    ctx.font = "18px NotoSans";
    const typeTextW = s?.type?.value ? ctx.measureText(s.type.value).width : 0;
    const sqStart =
      nameX + Math.max(nameTextW + 16 + rankTotalW, typeTextW) + 20;

    // 10-12 capsule anchored to right edge of bar
    const capX = rightX + skillBarW - capPad - capW;
    const capCY = barY + barH / 2;

    // Dynamic rect width to fill space between name and capsule
    const sqEnd = capX - capPad;
    const dynSqW = Math.max(16, Math.floor((sqEnd - sqStart - 8 * sqGap) / 9));
    const sqY = barY + barH / 2 - sqH / 2;

    for (let lv = 1; lv <= 9; lv++) {
      const sqX = sqStart + (lv - 1) * (dynSqW + sqGap);
      const unlocked = level >= lv;
      ctx.fillStyle = unlocked ? "#ffffff" : "#d8d8d8";
      roundRect(ctx, sqX, sqY, dynSqW, sqH, sqR, true);
      ctx.strokeStyle = "#aaaaaa";
      ctx.lineWidth = 1.5;
      roundRect(ctx, sqX, sqY, dynSqW, sqH, sqR, false);
    }

    // 10-12 indicator: 3 equal circles, touching each other
    const r = spotR; // all three same radius
    const leftCX = capX + r;
    const rightCX = leftCX + r * 2; // touching left circle
    const topRightCY = capCY - r; // touching each other vertically
    const botRightCY = capCY + r;

    const dotPositions = [
      { cx: leftCX, cy: capCY, lv: 10 },
      { cx: rightCX, cy: topRightCY, lv: 11 },
      { cx: rightCX, cy: botRightCY, lv: 12 },
    ];
    for (const { cx, cy, lv } of dotPositions) {
      // Dark border background
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
      ctx.fill();
      // Fill: white if unlocked, gray if not
      ctx.fillStyle = level >= lv ? "#ffffff" : "#cccccc";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = "left";
  }
  ctx.textAlign = "left";

  // --- TALENT SECTION (to the right of skills) ---
  {
    const talentX = rightX + skillBarW + 40;
    const talentSectionW = width - padding - talentX;
    const talentColW = Math.floor((talentSectionW - 20) / 2);
    const tiSize = 44;
    const dashW = 20;

    const abilityTalents: any[] = char.charData.abilityTalents || [];
    const combatTalents: any[] = char.charData.combatTalents || [];
    const cultivationTalents: any[] = char.charData.cultivationTalents || [];

    // Build unlock lookup sets from char.talent
    const talentData = (char as any).talent || {};
    const unlockedAttrNodes = new Set<string>(talentData.attrNodes || []);

    const buildLatestTierMap = (nodes: string[]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const nodeId of nodes) {
        const parts = nodeId.split("_");
        const tier = parseInt(parts.pop() || "0");
        const chainKey = parts.join("_");
        map.set(chainKey, Math.max(map.get(chainKey) ?? 0, tier));
      }
      return map;
    };
    const latestPassiveMap = buildLatestTierMap(
      talentData.latestPassiveSkillNodes || [],
    );
    const latestSpaceshipMap = buildLatestTierMap(
      talentData.latestSpaceshipSkillNodes || [],
    );

    const isAbilityUnlocked = (id: string) => unlockedAttrNodes.has(id);
    const isCombatUnlocked = (id: string) => {
      const parts = id.split("_");
      const tier = parseInt(parts.pop() || "0");
      const chainKey = parts.join("_");
      return tier <= (latestPassiveMap.get(chainKey) ?? 0);
    };
    const isCultivationUnlocked = (id: string) => {
      const parts = id.split("_");
      const tier = parseInt(parts.pop() || "0");
      const chainKey = parts.join("_");
      return tier <= (latestSpaceshipMap.get(chainKey) ?? 0);
    };

    // Section title
    ctx.fillStyle = "#333";
    ctx.font = "bold 44px NotoSansTCBold";
    ctx.textAlign = "left";
    ctx.fillText(`I ${tr("canvas_Talents")}`, talentX, skillsY);

    // Helper: draw a talent icon — circle or rounded square
    const drawTalentIcon = async (
      item: any,
      x: number,
      y: number,
      size: number,
      square = false,
      unlocked = true,
    ) => {
      const url = unlocked
        ? item?.iconUrl || item?.lockedIconUrl
        : item?.lockedIconUrl || item?.iconUrl;
      const bgColor = unlocked ? "#e8b84b" : "#cccccc";
      if (square) {
        ctx.fillStyle = bgColor;
        roundRect(ctx, x, y, size, size, size * 0.2, true);
        if (url) {
          try {
            const img = await fetchImage(url);
            ctx.save();
            ctx.beginPath();
            roundRect(
              ctx,
              x + 2,
              y + 2,
              size - 4,
              size - 4,
              size * 0.15,
              false,
            );
            ctx.clip();
            ctx.drawImage(img, x, y, size, size);
            ctx.restore();
          } catch (_) {}
        }
        ctx.strokeStyle = "#555555";
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, size, size, size * 0.2, false);
      } else {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();
        if (url) {
          try {
            const img = await fetchImage(url);
            ctx.save();
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2 - 2, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(img, x, y, size, size);
            ctx.restore();
          } catch (_) {}
        }
        ctx.strokeStyle = "#555555";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    // Helper: group talents by iconUrl, sort each group by the last numeric ID suffix (ascending tier)
    const groupTalents = (talents: any[]) => {
      const map = new Map<string, any[]>();
      for (const t of talents) {
        const key = t.iconUrl || t.id;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      }
      return Array.from(map.values()).map((g) =>
        g.sort((a: any, b: any) => {
          const aNum = parseInt(a.id.split("_").pop() || "0");
          const bNum = parseInt(b.id.split("_").pop() || "0");
          return aNum - bNum;
        }),
      );
    };

    // Draw dash connector between icons
    const drawDash = (x: number, y: number) => {
      ctx.fillStyle = "#aaaaaa";
      ctx.fillRect(x + 3, y + tiSize / 2 - 2, dashW - 6, 4);
    };

    // --- abilityTalents: small circles in a row ---
    const abRowY = skillsY + 30;
    for (let i = 0; i < abilityTalents.length && i < 6; i++) {
      const ix = talentX + i * (tiSize + 12);
      await drawTalentIcon(
        abilityTalents[i],
        ix,
        abRowY,
        tiSize,
        false,
        isAbilityUnlocked(abilityTalents[i]?.id),
      );
    }

    // Helper: draw tier mark image (bottom-right of icon)
    const drawTierMarks = async (ix: number, chainY: number, count: number) => {
      try {
        const img = await loadLocalImage(`skill_property/${count}.png`);
        const imgH = 16;
        const imgW = Math.round((img.width / img.height) * imgH);
        ctx.drawImage(
          img,
          ix + tiSize - imgW + 15,
          chainY + tiSize - imgH + 5,
          imgW,
          imgH,
        );
      } catch (e) {}
    };

    // --- combatTalents: 2 columns, each column shows a chain ---
    const combatGroups = groupTalents(combatTalents);
    const combatRowY = abRowY + tiSize + 28;
    for (let g = 0; g < combatGroups.length && g < 2; g++) {
      const group = combatGroups[g];
      const colX = talentX + g * (talentColW + 20);

      // Group name above the chain
      ctx.fillStyle = "#555";
      ctx.font = "bold 22px NotoSansTCBold";
      ctx.textAlign = "left";
      ctx.fillText(group[0]?.name || "", colX, combatRowY + 16);

      // Icon chain with tier marks at bottom-right of each icon
      const chainY = combatRowY + 25;
      for (let t = 0; t < group.length && t < 3; t++) {
        const ix = colX + t * (tiSize + dashW);
        await drawTalentIcon(
          group[t],
          ix,
          chainY,
          tiSize,
          false,
          isCombatUnlocked(group[t]?.id),
        );
        await drawTierMarks(ix, chainY, t + 1);
        if (t < group.length - 1) drawDash(ix + tiSize, chainY);
      }
    }

    // --- cultivationTalents: 2 columns, each with Greek label image beside each icon ---
    const cultivGroups = groupTalents(cultivationTalents);
    const cultivRowY = combatRowY + tiSize + 55;
    const greekImgMap: Record<string, string> = {
      α: "alpha",
      β: "beta",
      γ: "gemma",
    };
    const greekFallback = ["α", "β", "γ", "δ"];
    for (let g = 0; g < cultivGroups.length && g < 2; g++) {
      const group = cultivGroups[g];
      const colX = talentX + g * (talentColW + 20);

      // Base name (strip trailing ·β/·γ etc.)
      const baseName = (group[0]?.name || "")
        .replace(/[··][αβγδεζηθ]$/, "")
        .trim();
      ctx.fillStyle = "#555";
      ctx.font = "bold 22px NotoSansTCBold";
      ctx.textAlign = "left";
      ctx.fillText(baseName, colX, cultivRowY + 16);

      // Icon chain with Greek label to the bottom-right of each icon
      const chainY = cultivRowY + 25;
      const gImgH = 28;
      const gImgW = Math.round((42 / 60) * gImgH); // ≈ 14px
      const labelStride = tiSize + dashW + 6;
      for (let t = 0; t < group.length && t < 4; t++) {
        const ix = colX + t * labelStride;
        await drawTalentIcon(
          group[t],
          ix,
          chainY,
          tiSize,
          true,
          isCultivationUnlocked(group[t]?.id),
        );

        // Greek letter image at bottom-right of icon (overlay)
        const tierMatch = group[t]?.name?.match(/[··]([αβγδεζηθ])$/);
        const letter = tierMatch ? tierMatch[1] : (greekFallback[t] ?? "");
        const imgName = greekImgMap[letter];
        if (imgName) {
          try {
            const gImg = await loadLocalImage(`skill_property/${imgName}.png`);
            ctx.drawImage(
              gImg,
              ix + tiSize - gImgW + 20,
              chainY + tiSize - gImgH + 10,
              gImgW,
              gImgH,
            );
          } catch (e) {}
        }

        // Dash connector between icon+label groups
        if (t < group.length - 1) {
          ctx.fillStyle = "#aaaaaa";
          ctx.fillRect(ix + tiSize + 3, chainY + tiSize / 2 - 2, dashW - 2, 4);
        }
      }
    }

    ctx.textAlign = "left";
  }

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
    equipKey = "",
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

    // Scaled font sizes based on cardH
    const isCompact = cardH < 180;

    // 1. Level / Title Section
    ctx.fillStyle = "#111";
    if (isTac) {
      // Draw tacticalItem icon before name (32px, vertically centred with text)
      const tacIconSize = 32;
      const tacNameFontSize = 32;
      const tacTextBaseline = ey + 50;
      // visual mid of cap ≈ baseline - fontSize * 0.38
      const tacTextMidY = tacTextBaseline - tacNameFontSize * 0.38;
      const tacIconX = ex + 30;
      const tacIconY = tacTextMidY - tacIconSize / 2;
      try {
        const tacIcon = await loadLocalImage("skill_property/tacticalItem.png");
        ctx.drawImage(tacIcon, tacIconX, tacIconY, tacIconSize, tacIconSize);
      } catch (_) {}
      ctx.font = `bold ${tacNameFontSize}px NotoSansTCBold`;
      ctx.fillText(
        data?.name || "??",
        ex + 30 + tacIconSize + 8,
        tacTextBaseline,
      );
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
    const nameY = ey + cardH - 50;
    const effectStr = isTac
      ? parseEffectString(data?.activeEffect, data?.activeEffectParams)
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
      // 4. Bottom row: gray background bar + type icon + Name + Suit + Tags
      const barH = 52;
      const barY = ey + cardH - barH;
      const barCY = barY + barH / 2;

      // Type icon from skill_property
      const typeIconSize = 32;
      const typeIconX = ex + 30;
      const typeIconY = barCY - typeIconSize / 2;
      if (equipKey) {
        try {
          const typeIcon = await loadLocalImage(
            `skill_property/${equipKey}.png`,
          );
          ctx.drawImage(
            typeIcon,
            typeIconX,
            typeIconY,
            typeIconSize,
            typeIconSize,
          );
        } catch (e) {}
      }
      const contentX = ex + 30 + (equipKey ? typeIconSize + 6 : 0);

      const props = data?.properties || [];
      const suitName = data?.suit?.name;
      const tagFontSize = tr.lang === "en" ? 14 : 20;
      const textPadding = tr.lang === "en" ? 6 : 14;
      const tagGap = 6;

      // 4a. Tags total width
      ctx.font = `bold ${tagFontSize}px NotoSansTCBold`;
      const tagWidths: number[] = [];
      let totalTagsW = 0;
      const displayedProps = [...props].filter((p: string) => !!p).slice(0, 3);
      displayedProps.forEach((pKey: string) => {
        const enumItem = enums.find((v: any) => v.key === pKey);
        const labelText = enumItem?.value || pKey.replace("equip_attr_", "");
        const tW = ctx.measureText(labelText).width + textPadding;
        tagWidths.push(tW);
        totalTagsW += tW + tagGap;
      });

      // 4b. Available space for Name + Suit
      const suitPillW = suitName
        ? ctx.measureText(suitName).width + (tr.lang === "en" ? 10 : 20)
        : 0;
      const rightMargin = 30;
      const spaceForNameAndSuit =
        cardW - totalTagsW - (contentX - ex) - rightMargin - 15;
      const nameMaxWidth =
        spaceForNameAndSuit - (suitPillW > 0 ? suitPillW + 8 : 0);
      const nameStr = data?.name || tr("None");
      const baseNameSize = tr.lang === "en" ? 28 : 30;

      // 4c. Tags (right to left), vertically centered on barCY
      let currentRightX = ex + cardW - rightMargin;
      ctx.textBaseline = "middle";
      [...displayedProps].reverse().forEach((pKey, i) => {
        const enumItem = enums.find((v: any) => v.key === pKey);
        const labelText = enumItem?.value || pKey.replace("equip_attr_", "");
        const bgW = tagWidths[displayedProps.length - 1 - i];
        const tagH = 32;
        const labelX = currentRightX - bgW;
        ctx.fillStyle = "rgba(0,0,0,0.08)";
        roundRect(ctx, labelX, barCY - tagH / 2, bgW, tagH, 6, true);
        ctx.fillStyle = "#555";
        ctx.textAlign = "center";
        ctx.fillText(labelText, labelX + bgW / 2, barCY);
        ctx.textAlign = "left";
        currentRightX -= bgW + tagGap;
      });

      // 4d. Name + Suit, vertically centered on barCY
      ctx.fillStyle = "#111";
      fillDynamicText(
        ctx,
        nameStr,
        contentX,
        barCY - 20,
        nameMaxWidth,
        baseNameSize,
        detail,
        true,
      );

      ctx.font = `bold ${baseNameSize}px NotoSansTCBold`;
      const actualNameW = Math.min(
        ctx.measureText(nameStr).width,
        nameMaxWidth,
      );

      if (suitName) {
        const suitX = contentX + actualNameW + 8;
        const suitH = 32;
        ctx.font = `bold ${tagFontSize}px NotoSansTCBold`;
        ctx.fillStyle = rarityColor;
        roundRect(ctx, suitX, barCY - suitH / 2, suitPillW, suitH, 6, true);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(suitName, suitX + suitPillW / 2, barCY);
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

    // Weapon Phase + Refine pill container (inline right of LEVEL)
    {
      const wPhase = char.weapon.breakthroughLevel ?? 0;
      const wRefine = char.weapon.refineLevel ?? 0;
      const iconSize = 36;
      const cellPad = 6;
      const cellW = iconSize + cellPad * 2;
      const containerH = iconSize + cellPad * 2;
      const containerW = cellW * 2 + 2;
      const containerX = rightX + 45 + wLvW + 10 + wLabelW + 16;
      const containerY = wCardY + 70 - containerH / 2 - 15;

      ctx.fillStyle = "rgba(80,80,80,0.75)";
      roundRect(ctx, containerX, containerY, containerW, containerH, 10, true);

      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(containerX + cellW, containerY + 7, 2, containerH - 14);

      // Left cell: breakthrough (phase)
      try {
        const phaseImg = await loadLocalImage(`phase/${wPhase}.png`);
        ctx.drawImage(
          phaseImg,
          containerX + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}

      // Right cell: refine level (rank)
      try {
        const refineImg = await loadLocalImage(`rank/${wRefine}.png`);
        ctx.drawImage(
          refineImg,
          containerX + cellW + 2 + cellPad,
          containerY + cellPad,
          iconSize,
          iconSize,
        );
      } catch (_) {}
    }

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
  const slotX = rightX + wCardW + eGap;

  // Gem slot title (same style as weapon title)
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText(`I ${tr("canvas_Gem")}`, slotX, weaponTitleY);

  ctx.fillStyle = "#fcfcfc";
  ctx.shadowColor = "rgba(0,0,0,0.05)";
  ctx.shadowBlur = 10;
  roundRect(ctx, slotX, wCardY, wSlotW, wCardH, 15, true);
  ctx.shadowBlur = 0;

  let hasGem = false;
  const gemData = char.weapon?.gem;
  if (gemData) {
    const gIcon = gemData.gemData?.icon || gemData.iconUrl || gemData.icon;
    const templateId: string = gemData.gemData?.templateId || "";
    const rarityMatch = templateId.match(/rarity_(\d+)/);
    const rarityN = rarityMatch ? rarityMatch[1] : null;

    // Left rarity color bar (same as weapon card)
    if (rarityN) {
      const rarityColorMap: Record<string, string> = {
        "3": "rgba(51, 194, 255, 1)",
        "4": "rgba(179, 128, 255, 1)",
        "5": "rgba(255, 204, 0, 1)",
      };
      const barColor = rarityColorMap[rarityN] || "rgb(14, 6, 6)";
      ctx.fillStyle = barColor;
      ctx.fillRect(slotX, wCardY, 12, wCardH);
    }

    if (gIcon) {
      try {
        const gbgImage = await loadLocalImage(`gem/${rarityN || "3"}.png`);
        const gImg = gIcon.startsWith("http")
          ? await fetchImage(gIcon)
          : await loadLocalImage(gIcon);
        const gemSize = 180;
        const gemX = slotX + (wSlotW - gemSize) / 2;
        const gemY = wCardY + (wCardH - gemSize) / 2 - 10;
        ctx.drawImage(gbgImage, gemX, gemY, gemSize, gemSize);
        ctx.drawImage(gImg, gemX, gemY, gemSize, gemSize);
        hasGem = true;
      } catch (e) {}
    }
  }

  if (!hasGem) {
    drawPlaceholder(slotX, wCardY, wSlotW, wCardH);
  }

  // 6. Detect active suit sets (≥3 pieces same suit.id)
  const allEquipData = [
    char.bodyEquip?.equipData,
    char.armEquip?.equipData,
    char.firstAccessory?.equipData,
    char.secondAccessory?.equipData,
  ].filter(Boolean);

  const suitCountMap = new Map<
    string,
    { suit: any; rKey: string; count: number }
  >();
  for (const d of allEquipData) {
    const sid = d?.suit?.id;
    if (!sid) continue;
    if (!suitCountMap.has(sid))
      suitCountMap.set(sid, {
        suit: d.suit,
        rKey: d.rarity?.key || "",
        count: 0,
      });
    suitCountMap.get(sid)!.count++;
  }
  const activeSuits = [...suitCountMap.values()].filter((s) => s.count >= 3);

  // 7. Configuration Grid — compact cards (no descriptions)
  const gridTitleY = wCardY + wCardH + 50;
  ctx.fillStyle = "#333";
  ctx.font = "bold 44px NotoSansTCBold";
  ctx.fillText(`I ${tr("canvas_Equipment")}`, rightX, gridTitleY);

  const egX = rightX;
  const egY = gridTitleY + 30;
  const colW1 = (rightW - eGap) / 2;
  const colW2 = colW1;

  const suitAreaH =
    activeSuits.length > 0 ? activeSuits.length * (100 + eGap) + 20 : 0;

  // Right column: firstAccessory/secondAccessory need ≥215px so the 150px icon
  // doesn't overlap the 52px bottom bar (10+150+52=212 < 215 ✓).
  // tacticalItem is more compact (no level/stars, smaller icon).
  const itemH_acc = 190; // firstAccessory & secondAccessory
  const itemH_tac = 180; // tacticalItem
  const rightHeights = [itemH_acc, itemH_acc, itemH_tac];

  // Total right column height (cards + gaps between them)
  const rightTotalH =
    rightHeights.reduce((s, h) => s + h, 0) + (rightHeights.length - 1) * eGap;

  // Left total must equal right total: 2*itemH_L + eGap = rightTotalH
  const itemH_L = (rightTotalH - eGap) / 2;

  const leftItems = [
    { item: char.bodyEquip, type: tr("canvas_Armor"), equipKey: "bodyEquip" },
    { item: char.armEquip, type: tr("canvas_Bracer"), equipKey: "armEquip" },
  ];
  const rightItems = [
    {
      item: char.firstAccessory,
      type: tr("canvas_Accessory"),
      equipKey: "firstAccessory",
    },
    {
      item: char.secondAccessory,
      type: tr("canvas_Accessory"),
      equipKey: "secondAccessory",
    },
    {
      item: char.tacticalItem,
      type: tr("canvas_TacticalItem"),
      isTac: true,
      equipKey: "tacticalItem",
    },
  ];

  for (let i = 0; i < leftItems.length; i++) {
    const e = leftItems[i];
    await drawEquipCard(
      e,
      egX,
      egY + i * (itemH_L + eGap),
      colW1,
      itemH_L,
      false,
      e.equipKey,
    );
  }

  let rightY = egY;
  for (let i = 0; i < rightItems.length; i++) {
    const e = rightItems[i];
    const h = rightHeights[i];
    await drawEquipCard(
      e,
      egX + colW1 + eGap,
      rightY,
      colW2,
      h,
      false,
      e.equipKey,
    );
    rightY += h + eGap;
  }

  // 8. Active Suit Effects Section
  if (activeSuits.length > 0) {
    const descFontSize = 20;
    const descLineH = 26;
    const headerH = 60; // badge + name row height
    const vPad = 14; // vertical padding top+bottom inside card
    const descMaxW = rightW - 60; // max width for description text

    let sy = egY + rightTotalH + 20;

    for (let si = 0; si < activeSuits.length; si++) {
      const { suit, rKey, count } = activeSuits[si];
      const suitColor = getRarityColor(rKey);

      // Pre-measure description to determine card height
      const desc = parseEffectString(suit.skillDesc, suit.skillDescParams);
      ctx.font = `${descFontSize}px NotoSansTCBold`;
      const descLines = desc ? measureLines(ctx, desc, descMaxW) : 0;
      const descBlockH = descLines * descLineH;

      // Badge width needed for layout
      ctx.font = "bold 18px NotoSansTCBold";
      const badge = `${tr("canvas_Suit", { count: Math.min(3, count) })}`;
      const badgeW = ctx.measureText(badge).width + 16;

      const suitCardH =
        vPad + headerH + (descLines > 0 ? descBlockH + 8 : 0) + vPad;

      // Background card
      ctx.fillStyle = "#fcfcfc";
      ctx.shadowColor = "rgba(0,0,0,0.05)";
      ctx.shadowBlur = 8;
      roundRect(ctx, egX, sy, rightW, suitCardH, 12, true);
      ctx.shadowBlur = 0;

      // Left rarity bar
      ctx.fillStyle = suitColor;
      ctx.fillRect(egX, sy, 12, suitCardH);

      // Piece-count badge
      ctx.font = "bold 18px NotoSansTCBold";
      ctx.fillStyle = suitColor;
      roundRect(
        ctx,
        egX + 20,
        sy + vPad + (headerH - 28) / 2,
        badgeW,
        28,
        6,
        true,
      );
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(badge, egX + 28, sy + vPad + headerH / 2);

      // Suit name
      ctx.fillStyle = "#111";
      ctx.font = "bold 30px NotoSansTCBold";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(
        suit.name || "",
        egX + 20 + badgeW + 10,
        sy + vPad + headerH / 2 + 10,
      );

      // Suit description (no maxH — draw all lines)
      if (desc) {
        ctx.fillStyle = "#555";
        ctx.font = `${descFontSize}px NotoSansTCBold`;
        wrapText(
          ctx,
          desc,
          egX + 20,
          sy + vPad + headerH + descLineH,
          descMaxW,
          descLineH,
        );
      }

      ctx.textBaseline = "alphabetic";
      sy += suitCardH + eGap;
    }
  }

  return canvas.toBuffer("image/webp", 90);
}
