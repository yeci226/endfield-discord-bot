import {
  createCanvas,
  GlobalFonts,
  CanvasRenderingContext2D,
  loadImage,
} from "@napi-rs/canvas";
import path from "path";
import moment from "moment";
import { GachaLogData } from "./gachaLogUtils";
import { fetchImage } from "./canvasUtils";

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

function normalizeGachaText(text: string): string {
  return (text || "")
    .replace(/：/g, " : ")
    .replace(/（/g, " (")
    .replace(/）/g, ") ");
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

export type GachaType =
  | "limited_char"
  | "standard_char"
  | "beginner_char"
  | "weapon";

export const ITEMS_PER_PAGE = 28; // 4 rows × 7 cols

export function getDetailedPageCount(
  items: any[],
  includesPlaceholder: boolean,
): number {
  const effectiveItems = includesPlaceholder ? items.length + 1 : items.length;
  return Math.max(1, Math.ceil(effectiveItems / ITEMS_PER_PAGE));
}

export async function drawGachaStats(
  data: GachaLogData,
  stats: any,
  tr: any,
  type: GachaType = "limited_char",
  selectedPoolId?: string,
  page: number = 0,
): Promise<Buffer> {
  const apiLang = data.info.lang || "zh-tw";
  const isEn = apiLang.toLowerCase().includes("en");
  const apiServerId = data.info.serverId || "2";
  // Load Pool API Data if applicable
  let poolApiData: any = null;
  if (selectedPoolId) {
    try {
      const res = await fetch(
        `https://ef-webview.gryphline.com/api/content?lang=${apiLang}&pool_id=${selectedPoolId}&server_id=${apiServerId}`,
      );
      if (res.ok) {
        const json = await res.json();
        if (json.code === 0 && json.data?.pool) {
          poolApiData = json.data.pool;
        }
      }
    } catch (e) {
      console.error("[drawGachaStats] Failed to fetch Gryphline API", e);
    }
  }

  const width = 2400;
  const height = 1400;
  const padding = 80;

  if (!stats) {
    console.error("[drawGachaStats] stats object is null or undefined");
    return Buffer.alloc(0);
  }

  const baseType = type === "weapon" ? "weapon" : "char";
  const poolStats = stats[baseType];

  if (!poolStats) {
    console.error(
      `[drawGachaStats] poolStats is undefined for baseType: ${baseType}`,
    );
    return Buffer.alloc(0);
  }

  const totalPulls = poolStats.total ?? 0;
  const history = poolStats.history || [];

  // 1. Grouping for Visuals
  const visualGroups: {
    title: string;
    items: any[];
    gId: string;
    pId?: string;
  }[] = [];

  if (!selectedPoolId) {
    // Overview Mode: Find Top 3 Pools based on selected category (type)
    const pools = (type === "weapon" ? stats.weapon.pools : stats.char.pools)
      .filter((p: any) => {
        if (type === "weapon") return p.type?.includes("Weapon");
        if (type === "standard_char")
          return p.type?.includes("Standard") && !p.name?.includes("新手");
        if (type === "beginner_char")
          return p.type?.includes("Beginner") || p.name?.includes("新手");
        return p.type?.includes("Special"); // Default to Special for limited_char
      })
      .slice(0, 3);

    for (const p of pools) {
      const items = history.filter(
        (item: any) => item.poolId === p.id && item.rarity >= 6,
      );

      let gId = "SpecialShared";
      if (type === "weapon") {
        gId = p.id;
      } else if (p.type?.includes("Beginner")) {
        gId = "Beginner";
      } else if (p.type?.includes("Standard")) {
        gId = `Standard_${p.id}`;
      }

      const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
      const pTotal = gSummary[gId]?.poolTotalMap?.[p.id] || 0;

      visualGroups.push({
        title: normalizeGachaText(p.name),
        items,
        gId,
        pId: p.id,
      });
    }
  } else {
    // Detailed Mode: Focus on specific pool
    const items = history.filter(
      (item: any) => item.poolId === selectedPoolId && item.rarity >= 4,
    );
    const pool = (
      type === "weapon" ? stats.weapon.pools : stats.char.pools
    ).find((p: any) => p.id === selectedPoolId);

    let gId = "SpecialShared";
    if (type === "weapon") {
      gId = pool?.id || selectedPoolId;
    } else if (pool?.type?.includes("Beginner")) {
      gId = "Beginner";
    } else if (pool?.type?.includes("Standard")) {
      gId = `Standard_${pool.id}`;
    }

    const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
    const pTotal = gSummary[gId]?.poolTotalMap?.[selectedPoolId] || 0;

    visualGroups.push({
      title: normalizeGachaText(
        pool?.name || (tr?.("gacha_log_canvas_ListLabel") ?? "尋訪清單"),
      ),
      items,
      gId,
    });
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#f4f6f8";
  ctx.fillRect(0, 0, width, height);

  // Draw bottom-right decoration FIRST (behind all content)
  try {
    const bgRbImg = await loadImage(
      path.join(__dirname, "../assets/bg-rb.png"),
    );
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.drawImage(bgRbImg, width - bgRbImg.width, height - bgRbImg.height);
    ctx.restore();
  } catch (e) {
    console.error("[drawGachaStats] Error drawing bg-rb.png", e);
  }

  // 2. Header
  ctx.fillStyle = "#111";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.textAlign = "left";
  ctx.fillText(
    tr("gacha_log_stats_Title", { uid: data.info.nickname || stats.uid }),
    padding,
    150,
  );

  // Branding: Official Vertical Style (Top Right)
  const brandX = width;
  const brandY = 0;

  // Slanted Yellow Polygon
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(brandX, 0);
  ctx.lineTo(brandX, 600);
  ctx.lineTo(brandX - 400, 0);
  ctx.closePath();
  ctx.fillStyle = "#ffcc00";
  ctx.fill();
  ctx.restore();

  // Vertical Text
  ctx.save();
  ctx.translate(brandX - 35, 60);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.letterSpacing = "4px";
  ctx.fillText("ENDFIELD INDUSTRIES", 0, 0);
  ctx.restore();

  ctx.fillStyle = "#888";
  ctx.font = "bold 40px NotoSans";
  const typeLabel =
    type === "weapon"
      ? tr("gacha_log_stats_WeaponPool")
      : type === "limited_char"
        ? tr("gacha_log_stats_LimitedCharPool")
        : tr("gacha_log_stats_StandardCharPool");
  ctx.fillText(
    `${typeLabel} — ${moment().format("YYYY/MM/DD HH:mm")}`,
    padding,
    210,
  );

  // 3. Summary Area (Horizontal Cards)
  const summaryY = 280;
  const summaryH = 220;
  const cardGap = 40;
  const cardW = (width - padding * 2 - cardGap * 2) / 3;

  // Filter total pulls by current pool group
  // For Character limited, we should only sum history from SpecialShared group
  const groupStats = stats[baseType].summary;
  let activePulls = 0;
  let activeSixCount = 0;
  let featuredSixCount = 0;

  if (selectedPoolId) {
    // Determine the group ID for the selected pool
    const pool = (
      type === "weapon" ? stats.weapon.pools : stats.char.pools
    ).find((p: any) => p.id === selectedPoolId);
    let currentGId = "SpecialShared";
    if (type === "weapon") currentGId = selectedPoolId;
    else if (pool?.type?.includes("Beginner")) currentGId = "Beginner";
    else if (pool?.type?.includes("Standard"))
      currentGId = `Standard_${pool.id}`;

    activePulls = groupStats[currentGId]?.total || 0;

    // We can't easily get total 6-stars for a specific pool group from summary alone if history is mixed,
    // but we can count from history
    const filteredHistory = history.filter((r: any) => {
      if (r.rarity < 6) return false;
      if (currentGId === "SpecialShared")
        return r.poolType?.includes("Special");
      if (currentGId === "Beginner") return r.poolType?.includes("Beginner");
      if (currentGId.startsWith("Standard")) return r.poolId === selectedPoolId;
      return r.poolId === selectedPoolId;
    });

    activeSixCount = filteredHistory.length;
    featuredSixCount = filteredHistory.filter((r: any) => r.isFeatured).length;
  } else {
    if (type === "weapon") {
      activePulls = totalPulls;
      const filteredHistory = history.filter((r: any) => r.rarity >= 6);
      activeSixCount = filteredHistory.length;
      featuredSixCount = filteredHistory.filter(
        (r: any) => r.isFeatured,
      ).length;
    } else {
      activePulls = groupStats["SpecialShared"]?.total || 0;
      const filteredHistory = history.filter(
        (r: any) => r.rarity >= 6 && r.poolType?.includes("Special"),
      );
      activeSixCount = filteredHistory.length;
      featuredSixCount = filteredHistory.filter(
        (r: any) => r.isFeatured,
      ).length;
    }
  }

  const rateUpWinRate =
    activeSixCount > 0
      ? ((featuredSixCount / activeSixCount) * 100).toFixed(2) + "%"
      : "0.00%";

  const mainSummary = [
    {
      label: tr?.("gacha_log_canvas_TotalPulls") ?? "總累計抽數",
      value: String(activePulls),
      icon: "📊",
    },
    {
      label: selectedPoolId
        ? (tr?.("gacha_log_canvas_CurrentTotal") ?? "當期總抽數")
        : (tr?.("gacha_log_canvas_SixStarRate") ?? "6星出率 (含保底)"),
      value: selectedPoolId
        ? String(history.filter((r: any) => r.poolId === selectedPoolId).length)
        : activePulls > 0
          ? ((activeSixCount / activePulls) * 100).toFixed(2) + "%"
          : "0.00%",
      icon: selectedPoolId ? "📅" : "✨",
    },
    {
      label:
        type === "weapon"
          ? (tr?.("gacha_log_canvas_UpWeaponWinRate") ?? "UP武器不歪率")
          : (tr?.("gacha_log_canvas_UpCharWinRate") ?? "UP角色不歪率"),
      value: rateUpWinRate,
      icon: "�",
    },
  ];

  mainSummary.forEach((s, i) => {
    const x = padding + i * (cardW + cardGap);
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 15;
    roundRect(ctx, x, summaryY, cardW, summaryH, 30, true);
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.fillStyle = "#111";
    ctx.font = "bold 80px NotoSansTCBold";
    ctx.fillText(s.value, x + cardW / 2, summaryY + 110);
    ctx.fillStyle = "#999";
    ctx.font = "32px NotoSans";
    ctx.fillText(s.label, x + cardW / 2, summaryY + 170);
  });

  // 4. History Groups
  const listY = summaryY + summaryH + 80;

  if (!selectedPoolId) {
    // OVERVIEW: 3 Columns Horizontal Layout
    const colW = (width - padding * 2 - cardGap * 2) / 3;
    for (let i = 0; i < visualGroups.length; i++) {
      const group = visualGroups[i];
      const curX = padding + i * (colW + cardGap);
      let curY = listY;

      // Pool Group Header
      ctx.textAlign = "left";
      ctx.fillStyle = "#111";
      ctx.font = "bold 44px NotoSansTCBold";
      const poolTitle = `I ${group.title}`;
      ctx.fillText(poolTitle, curX, curY);

      // Total Pulls in Grey Next to Title
      const titleWidth = ctx.measureText(poolTitle).width;
      const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
      const gId = group.gId;
      const pTotal = gSummary[gId]?.poolTotalMap?.[group.pId || "unknown"] || 0;

      ctx.fillStyle = "#888"; // Grey text
      ctx.font = "28px NotoSans"; // Smaller font
      ctx.fillText(
        tr("gacha_log_canvas_TotalCount").replace("<pTotal>", String(pTotal)),
        curX + titleWidth + 15,
        curY,
      );

      curY += 70;

      // --- PITY PLACEHOLDER (Overview) ---
      const pityData = gSummary[gId || "unknown"];

      const isBeginner = gId === "Beginner" || group.title.includes("新手");
      const maxPity80 = isBeginner ? 40 : type === "weapon" ? 40 : 80;

      const currentSoftPity = pityData?.currentPity || 0;

      // Dynamic Hard Pity:
      // Character: 120 (Guarantee) or 240 (Spark)
      // Weapon: Fixed at 80 (resets upon hit)
      const hasObtainedFeatured =
        pityData?.hasFeaturedMap?.[group.pId || ""] || false;
      const curPoolTotal = pityData?.poolTotalMap?.[group.pId || ""] || 0;
      const hardCount = pityData?.featuredPityMap?.[group.pId || ""] || 0;

      const softRemaining = Math.max(0, maxPity80 - currentSoftPity);

      let hardRemaining = 0;
      let isSpark = false;
      if (type === "weapon") {
        hardRemaining = Math.max(0, 80 - hardCount);
      } else {
        if (!hasObtainedFeatured && curPoolTotal < 120) {
          hardRemaining = 120 - curPoolTotal;
        } else {
          isSpark = true;
          // Every 240 pulls yields a token
          hardRemaining = 240 - (curPoolTotal % 240);
          if (hardRemaining === 0) hardRemaining = 240;
        }
      }

      // Condition logic
      let showPlaceholder = false;
      if (isBeginner) {
        const hasSix = group.items.length > 0;
        if (!hasSix) showPlaceholder = true;
      } else if (gId?.includes("Standard")) {
        showPlaceholder = true;
      } else if ((gId === "SpecialShared" || type === "weapon") && i === 0) {
        // Only show placeholder for the LATEST Limited pool in Overview
        showPlaceholder = true;
      }

      let showPadding = false;
      if (
        (gId === "SpecialShared" || type === "weapon") &&
        i > 0 &&
        hardCount > 0
      ) {
        showPadding = true;
      }

      const rectH = 110;

      if (showPlaceholder) {
        // Draw Placeholder Card
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.02)";
        ctx.shadowBlur = 10;
        roundRect(ctx, curX, curY, colW, rectH, 20, true);
        ctx.shadowBlur = 0;

        ctx.fillStyle = "#ccc";
        ctx.fillRect(curX, curY, 8, rectH);

        const pCenterX = curX + 65;
        const pCenterY = curY + rectH / 2;
        ctx.beginPath();
        ctx.arc(pCenterX, pCenterY, 45, 0, Math.PI * 2);
        ctx.fillStyle = "#f0f2f5";
        ctx.fill();

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#999";
        ctx.font = "bold 60px NotoSansTCBold";
        ctx.fillText("?", pCenterX, pCenterY - 2);

        ctx.textAlign = "left";
        ctx.fillStyle = "#999";
        ctx.font = "bold 26px NotoSansTCBold";

        ctx.fillText(
          tr("gacha_log_canvas_NextSix"),
          pCenterX + 60,
          curY + rectH / 2 - 15,
        );
        ctx.fillStyle = "#111";
        ctx.font = "bold 24px NotoSansTCBold";
        ctx.fillText(
          tr("gacha_log_canvas_SoftRemaining").replace(
            "<softRemaining>",
            String(softRemaining),
          ),
          pCenterX + 60,
          curY + rectH / 2 + 15,
        );

        // For Special or Weapon, show hard guarantee (120 or 80) or Spark (240)
        if (gId === "SpecialShared" || type === "weapon") {
          ctx.fillStyle = "#888";
          ctx.font = "bold 18px NotoSans";
          const locKey = isSpark
            ? "gacha_log_canvas_SparkRemaining"
            : "gacha_log_canvas_HardRemaining";
          ctx.fillText(
            (tr(locKey) || tr("gacha_log_canvas_HardRemaining")).replace(
              "<hardRemaining>",
              String(hardRemaining),
            ),
            pCenterX + 60,
            curY + rectH / 2 + 40,
          );
        }

        ctx.restore();
        curY += rectH + 15;
      }

      if (showPadding) {
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.02)";
        ctx.shadowBlur = 10;
        roundRect(ctx, curX, curY, colW, 60, 15, true);
        ctx.shadowBlur = 0;

        ctx.fillStyle = "#ccc";
        ctx.fillRect(curX, curY, 8, 60);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#555";
        ctx.font = "bold 18px NotoSans";
        ctx.fillText(
          tr("gacha_log_canvas_PaddedCount").replace(
            "<hardCount>",
            String(hardCount),
          ),
          curX + colW / 2,
          curY + 30,
        );

        ctx.restore();
        curY += 60 + 15;
      }
      // ------------------------------------

      // Items (Only 6★)
      for (const item of group.items) {
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.02)";
        ctx.shadowBlur = 10;
        roundRect(ctx, curX, curY, colW, rectH, 20, true);
        ctx.shadowBlur = 0;

        ctx.fillStyle = "#ff7100";
        ctx.fillRect(curX, curY, 8, rectH);

        const centerX = curX + 65;
        const centerY = curY + rectH / 2;
        const radius = 45;

        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#eee";
        ctx.fill();

        // Icon
        if (item.charId || item.weaponId) {
          const cid = String(item.charId || item.weaponId).replace("icon_", "");
          const iconUrl = item.charId
            ? `https://endfieldtools.dev/assets/images/endfield/charicon/icon_${cid}.png`
            : `https://endfieldtools.dev/assets/images/endfield/itemicon/${cid}.png`;
          try {
            const cacheName = item.charId ? `icon_${cid}` : cid;
            const icon = await fetchImage(iconUrl, cacheName);
            ctx.save();
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius - 5, 0, Math.PI * 2);
            ctx.clip();

            const aspect = icon.width / icon.height;
            let drawW = radius * 2;
            let drawH = radius * 2;
            if (aspect > 1) {
              drawW = drawH * aspect;
            } else {
              drawH = drawW / aspect;
            }

            ctx.drawImage(
              icon,
              centerX - drawW / 2,
              centerY - drawH / 2,
              drawW,
              drawH,
            );
            ctx.restore();
          } catch (e) {}
        }

        ctx.textAlign = "left";
        ctx.fillStyle = "#111";
        ctx.font = "bold 30px NotoSansTCBold";
        const nameText = normalizeGachaText(item.name);
        ctx.fillText(nameText, centerX + 60, curY + rectH / 2 + 10);

        if (item.isOffRate) {
          const textWidth = ctx.measureText(nameText).width;
          drawOffRateBadge(
            ctx,
            centerX + 60 + textWidth + 30,
            curY + rectH / 2 + 2,
            22,
            isEn,
          );
        }

        ctx.textAlign = "right";
        if (
          item.isFree &&
          !(type === "weapon" || item.poolType?.includes("Special"))
        ) {
          ctx.fillStyle = "#ffcc00";
          ctx.font = "bold 26px NotoSansTCBold";
          ctx.fillText(
            tr("gacha_log_canvas_FreeRecruit"),
            curX + colW - 25,
            curY + rectH / 2 + 10,
          );
        } else {
          // Display the banner-specific total count
          ctx.fillStyle = "#ff7100";
          ctx.font = "bold 34px NotoSansTCBold";

          if (!item.isFree) {
            ctx.fillText(
              `${item.pitySixCount}`,
              curX + colW - 25,
              curY + rectH / 2 - 5,
            );
          }

          ctx.fillStyle = "#aaa";
          ctx.font = "20px NotoSans";
          ctx.fillText(
            tr("gacha_log_canvas_TotalCount").replace(
              "<pTotal>",
              String(item.poolTotalCount),
            ),
            curX + colW - 25,
            curY + rectH / 2 + (item.isFree ? 10 : 25),
          );
        }

        curY += rectH + 15;
        if (curY > height - 150) break; // page limit check
      }
    }
  } else {
    const group = visualGroups[0];

    // Calculate uniform gap for 7 columns
    // Canvas: 2400px wide
    // Right side: Yellow brand triangle takes ~130px at the top-right corner; use right gutter of 130px.
    // Left gutter: matches the header padding (80px)
    // Total usable: 2400 - 80 - 130 = 2190
    // Grid: 7 * 280 + 6 * 26 = 1960 + 156 = 2116
    // Left padding to center: 80 + (2190 - 2116) / 2 = 80 + 37 = 117
    // Right side check: 117 + 2116 = 2233, right gutter = 2400 - 2233 = 167 (fine)
    const gap = 26;
    const itemW = 280;
    const itemH = 120;
    const rightGutter = 130; // brand sidebar width
    const gridTotalW = itemW * 7 + gap * 6; // 2116
    const usableW = width - padding - rightGutter; // 2190
    const centerPadding = padding + Math.floor((usableW - gridTotalW) / 2); // ~117

    // Paginate: slice items for this page
    const showPlaceholder = (() => {
      const gId = group.gId;
      const isBeginner = gId === "Beginner" || group.title.includes("新手");
      const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
      const pityData = gSummary[gId];
      if (isBeginner)
        return !group.items.some((it: any) => (it.rarity || 0) >= 6);
      if (gId?.includes("Standard")) return true;
      const poolList = stats[type === "weapon" ? "weapon" : "char"].pools;
      const newestPoolId = poolList[0]?.id;
      return selectedPoolId === newestPoolId;
    })();

    const allItems = group.items;
    const pageStart = page * ITEMS_PER_PAGE;
    // On page 0, placeholder occupies slot 0 if visible
    const placeholderOnThisPage = showPlaceholder && page === 0;
    const itemsStart =
      page === 0
        ? showPlaceholder
          ? Math.max(0, pageStart)
          : pageStart
        : pageStart - (showPlaceholder ? 1 : 0);
    const effectiveStart =
      page === 0 ? 0 : pageStart - (showPlaceholder ? 1 : 0);
    const slotsOnPage = ITEMS_PER_PAGE - (placeholderOnThisPage ? 1 : 0);
    const pagedItems = allItems.slice(
      effectiveStart,
      effectiveStart + slotsOnPage,
    );

    let currentX = centerPadding;
    let currentY = listY;

    // Detailed Pool Group Header
    ctx.textAlign = "left";
    ctx.fillStyle = "#111";
    ctx.font = "bold 44px NotoSansTCBold";
    const poolTitle = `I ${group.title}`;
    ctx.fillText(poolTitle, centerPadding, currentY);

    const titleWidth = ctx.measureText(poolTitle).width;
    const pTotal = history.filter(
      (r: any) => r.poolId === selectedPoolId,
    ).length;
    ctx.fillStyle = "#888";
    ctx.font = "28px NotoSans";

    if (poolApiData?.up6_image) {
      try {
        const bannerImg = await fetchImage(
          poolApiData.up6_image,
          `banner_${selectedPoolId}`,
        );
        const bHeight = 120; // Match the item box height
        const bWidth = bannerImg.width * (bHeight / bannerImg.height);

        // Align to the right edge of the grid grid
        const gridRightEdge = centerPadding + itemW * 7 + gap * 6;
        const bX = gridRightEdge - bWidth;
        const bY = currentY - 60;

        ctx.save();
        ctx.beginPath();
        const r = 15;
        ctx.moveTo(bX + r, bY);
        ctx.arcTo(bX + bWidth, bY, bX + bWidth, bY + bHeight, r);
        ctx.arcTo(bX + bWidth, bY + bHeight, bX, bY + bHeight, r);
        ctx.arcTo(bX, bY + bHeight, bX, bY, r);
        ctx.arcTo(bX, bY, bX + bWidth, bY, r);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(bannerImg, bX, bY, bWidth, bHeight);
        ctx.restore();
      } catch (e) {}
    }

    currentY += 70;

    // --- PITY PLACEHOLDER (Detailed) ---
    const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
    // For detailed view, use the gId already determined in visualGroups
    const gId = group.gId;
    const pityData = gSummary[gId];

    const isBeginner = gId === "Beginner" || group.title.includes("新手");
    const maxPity80 = isBeginner ? 40 : type === "weapon" ? 40 : 80;

    // Dynamic Hard Pity:
    // Character: 120 (Guarantee) or 240 (Spark)
    // Weapon: Fixed at 80 (resets upon hit)
    const hasObtainedFeatured =
      pityData?.hasFeaturedMap?.[selectedPoolId || ""] || false;
    const curPoolTotal = pityData?.poolTotalMap?.[selectedPoolId || ""] || 0;
    const hardCount = pityData?.featuredPityMap?.[selectedPoolId || ""] || 0;

    let hardRemaining = 0;
    let isSpark = false;
    if (type === "weapon") {
      hardRemaining = Math.max(0, 80 - hardCount);
    } else {
      if (!hasObtainedFeatured && curPoolTotal < 120) {
        hardRemaining = 120 - curPoolTotal;
      } else {
        isSpark = true;
        hardRemaining = 240 - (curPoolTotal % 240);
        if (hardRemaining === 0) hardRemaining = 240;
      }
    }

    const currentSoftPity = pityData?.currentPity || 0;
    const softRemaining = Math.max(0, maxPity80 - currentSoftPity);

    // Condition logic: Show ONLY if newest pool, standard, or eligible beginner
    // Use the placeholder flag computed during pagination
    const showDetailedPlaceholder = placeholderOnThisPage;

    if (showDetailedPlaceholder) {
      // Draw Placeholder Card (Detailed Grid Style)
      ctx.save();
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.02)";
      ctx.shadowBlur = 10;
      roundRect(ctx, currentX, currentY, itemW, itemH, 15, true);
      ctx.shadowBlur = 0;

      ctx.fillStyle = "#ccc";
      ctx.fillRect(currentX, currentY, 8, itemH);

      const pRadius = 40;
      const pCenterX = currentX + pRadius + 15;
      const pCenterY = currentY + itemH / 2;

      ctx.beginPath();
      ctx.arc(pCenterX, pCenterY, pRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#f0f2f5";
      ctx.fill();

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#999";
      ctx.font = "bold 50px NotoSansTCBold";
      ctx.fillText("?", pCenterX, pCenterY - 2);

      ctx.textAlign = "left";
      ctx.fillStyle = "#999";
      ctx.font = "bold 22px NotoSansTCBold";
      ctx.fillText(
        tr?.("gacha_log_canvas_NextSix") ?? "距下一次 6 星",
        pCenterX + pRadius + 10,
        currentY + itemH / 2 - 20,
      );
      ctx.fillStyle = "#111";
      ctx.font = "bold 20px NotoSansTCBold";
      ctx.fillText(
        (
          tr?.("gacha_log_canvas_SoftRemaining") ??
          "剩餘 <softRemaining> 抽必得"
        ).replace("<softRemaining>", String(softRemaining)),
        pCenterX + pRadius + 10,
        currentY + itemH / 2 + 5,
      );

      // Only show hard guarantee for Special
      if (gId === "SpecialShared" || type === "weapon") {
        ctx.fillStyle = "#888";
        ctx.font = "16px NotoSans";
        const locKey = isSpark
          ? "gacha_log_canvas_SparkRemaining"
          : "gacha_log_canvas_HardRemaining";

        ctx.fillText(
          (tr?.(locKey) ?? "剩餘 <hardRemaining> 抽必得當期 6 星").replace(
            "<hardRemaining>",
            String(hardRemaining),
          ),
          pCenterX + pRadius + 10,
          currentY + itemH / 2 + 30,
        );
      }
      ctx.restore();

      currentX += itemW + gap;
    }
    // ------------------------------------

    for (const item of pagedItems) {
      const isSix = item.rarity >= 6;
      const isFive = item.rarity === 5;
      const isFour = item.rarity === 4;

      // Check for row wrap: use symmetric right gutter
      if (currentX + itemW > width - (centerPadding - padding + rightGutter)) {
        currentX = centerPadding;
        currentY += itemH + gap;
      }

      // Safeguard against height overflow for fixed canvas
      if (currentY + itemH > height - 50) break;

      const curX = currentX;
      const curY = currentY;

      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.02)";
      ctx.shadowBlur = 10;
      roundRect(ctx, curX, curY, itemW, itemH, 15, true);
      ctx.shadowBlur = 0;

      ctx.fillStyle = isSix ? "#ff7100" : isFive ? "#ffcc00" : "#b04dff";
      ctx.fillRect(curX, curY, 8, itemH);

      const radius = 40;
      const centerX = curX + radius + 15;
      const centerY = curY + itemH / 2;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#eee";
      ctx.fill();

      // Icon logic
      if (item.charId || item.weaponId) {
        const cid = String(item.charId || item.weaponId).replace("icon_", "");
        const iconUrl = item.charId
          ? `https://endfieldtools.dev/assets/images/endfield/charicon/icon_${cid}.png`
          : `https://endfieldtools.dev/assets/images/endfield/itemicon/${cid}.png`;
        try {
          const cacheName = item.charId ? `icon_${cid}` : cid;
          const icon = await fetchImage(iconUrl, cacheName);
          ctx.save();
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius - 4, 0, Math.PI * 2);
          ctx.clip();

          const aspect = icon.width / icon.height;
          let drawW = radius * 2;
          let drawH = radius * 2;
          if (aspect > 1) {
            drawW = drawH * aspect;
          } else {
            drawH = drawW / aspect;
          }

          ctx.drawImage(
            icon,
            centerX - drawW / 2,
            centerY - drawH / 2,
            drawW,
            drawH,
          );
          ctx.restore();
        } catch (e) {}
      }

      const fontSize = 28;
      const subFontSize = 18;

      ctx.textAlign = "left";
      ctx.fillStyle = "#111";
      ctx.font = `bold ${fontSize}px NotoSansTCBold`;
      const nameText = normalizeGachaText(item.name);
      ctx.fillText(nameText, centerX + radius + 10, curY + itemH / 2 - 5);

      if (item.isOffRate) {
        const textWidth = ctx.measureText(nameText).width;
        drawOffRateBadge(
          ctx,
          centerX + radius + 10 + textWidth + 20,
          curY + itemH / 2 - 13,
          18,
          isEn,
        );
      }

      ctx.fillStyle = "#888";
      ctx.font = `${subFontSize}px NotoSans`;
      ctx.fillText(
        moment(
          isNaN(Number(item.gachaTs)) ? item.gachaTs : Number(item.gachaTs),
        ).format("YY/MM/DD"),
        centerX + radius + 10,
        curY + itemH / 2 + 25,
      );

      ctx.textAlign = "right";
      if (
        item.isFree &&
        !(type === "weapon" || item.poolType?.includes("Special"))
      ) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = `bold 28px NotoSansTCBold`;
        ctx.fillText(
          tr?.("gacha_log_canvas_FreeRecruit") ?? "加急",
          curX + itemW - 15,
          curY + itemH / 2 + 10,
        );
      } else {
        const displayPity = isSix ? item.pitySixCount : item.pityCount;

        if (isSix) {
          ctx.fillStyle = "#ff7100";
          ctx.font = `bold ${fontSize + 4}px NotoSansTCBold`;
          if (!item.isFree) {
            ctx.fillText(
              `${displayPity}`,
              curX + itemW - 15,
              curY + itemH / 2 - 5,
            );
          }
          // Total
          ctx.fillStyle = "#888";
          ctx.font = `${subFontSize}px NotoSans`;
          ctx.fillText(
            `T${String(item.poolTotalCount)}`,
            curX + itemW - 15,
            curY + itemH / 2 + (item.isFree ? 10 : 20),
          );
        } else {
          ctx.fillStyle = isFive ? "#ffcc00" : "#b04dff";
          ctx.font = `bold ${fontSize + 4}px NotoSansTCBold`;
          if (!item.isFree) {
            ctx.fillText(
              `${displayPity}`,
              curX + itemW - 15,
              curY + itemH / 2 + 10,
            );
          }

          // Total
          ctx.fillStyle = "#888";
          ctx.font = `${subFontSize}px NotoSans`;
          ctx.fillText(
            `T${String(item.poolTotalCount)}`,
            curX + itemW - 15,
            curY + itemH / 2 + (item.isFree ? 25 : 35),
          );
        }
      }

      currentX += itemW + gap;
    }
  }

  return canvas.toBuffer("image/png");
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
  const normalizedText = (text || "").replace(/：/g, " : ");
  let fontSize = baseFontSize;
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
  let textWidth = ctx.measureText(normalizedText).width;

  while (textWidth > maxWidth && fontSize > 20) {
    fontSize -= 2;
    ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
    textWidth = ctx.measureText(normalizedText).width;
  }

  ctx.fillText(normalizedText, x, y, maxWidth);
}

function drawOffRateBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number = 22,
  isEn: boolean = false,
) {
  ctx.save();
  ctx.translate(x, y);

  if (isEn) {
    // Background circle for "L" (LOSE)
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#1e3a8a"; // Deep blue
    ctx.fill();

    // Text "L"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.3)}px NotoSansTCBold`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("L", 0, -1);
  } else {
    // Background circle for "歪" (Chinese)
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ff0000";
    ctx.fill();

    // Text "歪"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.1)}px NotoSansTCBold`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("歪", 0, -2.5);
  }

  ctx.restore();
}
