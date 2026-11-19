import { SKRSContext2D } from "@napi-rs/canvas";
import { fetchImage } from "../../../utils/canvasUtils";
import { loadGachaIconImage } from "../iconLoader";
import { drawQuickStrip } from "./quickStrip";
import {
  GachaStatsState,
  normalizeGachaText,
  formatSmallGachaTime,
  roundRect,
  fillDynamicText,
  drawOffRateBadge,
} from "./shared";

/** Overview: one column per pool, then the quick strip of older pools. */
export async function drawOverview(
  ctx: SKRSContext2D,
  state: GachaStatsState,
): Promise<void> {
  const {
    stats,
    tr,
    type,
    isEn,
    width,
    padding,
    visualGroups,
    listY,
    cardGap,
    poolBannerUrlMap,
    overviewBottomLimit,
    getPoolLatestGachaTs,
    drawBannerContain,
  } = state;
  // OVERVIEW: 3 Columns Horizontal Layout (fixed)
  const colW = (width - padding * 2 - cardGap * 2) / 3;
  // For standard/beginner single-pool overview, spread items across all 3 columns
  // since those pool types only ever have 1 visualGroup, leaving 2/3 of the canvas empty.
  const isSinglePoolSpread =
    visualGroups.length === 1 &&
    (type === "standard_char" || type === "beginner_char");
  for (let i = 0; i < visualGroups.length; i++) {
    const group = visualGroups[i];
    let curX = padding + i * (colW + cardGap);
    let curY = listY;

    // Pool Group Header
    ctx.textAlign = "left";
    const poolTitle = normalizeGachaText(group.title);
    const poolBannerUrl = group.pId
      ? poolBannerUrlMap.get(group.pId)
      : undefined;
    let titleRight = curX;
    ctx.fillStyle = "#111";
    ctx.font = "bold 52px NotoSansTCBold";
    ctx.fillText("I", curX, curY);
    const fallbackTitle = `I ${poolTitle}`;

    if (poolBannerUrl) {
      try {
        const bannerImg = await fetchImage(
          poolBannerUrl,
          `pool_header_${group.pId || `group_${i}`}`,
        );
        const bHeight = 320;
        const bWidth = colW;
        const bX = curX;
        const bY = curY - 170;

        drawBannerContain(bannerImg, bX, bY, bWidth, bHeight);

        ctx.save();
        ctx.textAlign = "left";
        ctx.fillStyle = "#000";
        fillDynamicText(
          ctx,
          fallbackTitle,
          curX + 15,
          curY,
          bWidth - 26,
          50,
          true,
        );
        ctx.restore();

        titleRight = bX + bWidth;
      } catch (e) {}
    }

    if (!poolBannerUrl) {
      ctx.fillText(fallbackTitle, curX, curY);
      titleRight = curX + ctx.measureText(fallbackTitle).width;
    }

    const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
    const gId = group.gId;
    const pId = group.pId || "unknown";
    const nonFreeCount = gSummary[gId]?.poolTotalMap?.[pId] || 0;
    const freeCount = gSummary[gId]?.poolFreeTotalMap?.[pId] || 0;

    let startX = titleRight + 16;
    let totalLineY = curY;
    if (poolBannerUrl) {
      startX = curX + 15;
      totalLineY = curY + 30;
    } else if (startX > curX + colW - 220) {
      startX = curX;
      totalLineY = curY + 36;
    }
    ctx.textBaseline = "alphabetic";

    // "總計"
    ctx.fillStyle = "#888";
    ctx.font = "24px NotoSans";
    ctx.fillText(
      tr("gacha_log_canvas_Total_Prefix").trim(),
      startX,
      totalLineY,
    );
    startX +=
      ctx.measureText(tr("gacha_log_canvas_Total_Prefix").trim()).width + 8;

    // Non-free count
    ctx.fillStyle = "#444";
    ctx.font = "bold 24px NotoSansTCBold";
    ctx.fillText(String(nonFreeCount), startX, totalLineY);
    startX += ctx.measureText(String(nonFreeCount)).width + 8;

    if (freeCount > 0) {
      // "+"
      ctx.fillStyle = "#888";
      ctx.font = "20px NotoSans";
      ctx.fillText("+", startX, totalLineY);
      startX += ctx.measureText("+").width + 8;

      // Free count
      ctx.fillStyle = "#ffcc00";
      ctx.font = "bold 24px NotoSansTCBold";
      ctx.fillText(String(freeCount), startX, totalLineY);
      startX += ctx.measureText(String(freeCount)).width + 8;
    }

    // "抽"
    ctx.fillStyle = "#888";
    ctx.font = "24px NotoSans";
    ctx.fillText(
      tr("gacha_log_canvas_Pulls_Suffix").trim(),
      startX,
      totalLineY,
    );

    curY = totalLineY + 70;

    // --- PITY PLACEHOLDER (Overview) ---
    const pityData = gSummary[gId || "unknown"];

    const isBeginner = gId === "Beginner" || group.title.includes("新手");
    const maxPity80 = isBeginner ? 40 : type === "weapon" ? 40 : 80;

    const groupPity = pityData?.currentPity || 0;

    // Dynamic Hard Pity:
    // Character: 120 (Guarantee) or 240 (Spark)
    // Weapon: Fixed at 80 (resets upon hit)
    const hasObtainedFeatured =
      pityData?.hasFeaturedMap?.[group.pId || ""] || false;
    const curPoolTotal = pityData?.poolTotalMap?.[group.pId || ""] || 0;
    const hardCount = pityData?.featuredPityMap?.[group.pId || ""] || 0;

    const softRemaining = Math.max(0, maxPity80 - groupPity);

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
    } else if (
      (gId === "SpecialShared" ||
        gId === "RerunShared" ||
        type === "weapon") &&
      i === 0
    ) {
      // Only show placeholder for the LATEST Limited pool in Overview
      showPlaceholder = true;
    }

    const rectH = 110;
    if (showPlaceholder && curY + rectH <= overviewBottomLimit) {
      // Draw Placeholder Card
      curY -= 40;
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

    // --- PADDED PULLS (Overview Gray Bar) ---
    {
      const poolItemsAll = stats[
        type === "weapon" ? "weapon" : "char"
      ].history.filter((r: any) => r.poolId === group.pId);
      const categorySummary =
        stats[type === "weapon" ? "weapon" : "char"].summary[
          group.gId || "unknown"
        ];
      const poolTotal = categorySummary?.poolTotalMap?.[group.pId || ""] || 0;

      const poolList = stats[type === "weapon" ? "weapon" : "char"].pools;
      const newestPoolId =
        type === "rerun_char"
          ? poolList.find((p: any) => p.type?.includes("Rerun"))?.id
          : poolList[0]?.id;
      const isNewestPool = group.pId === newestPoolId;

      let displayPity = 0;
      let carriedPity = 0;
      let thisPoolPulls = poolTotal;

      if (isNewestPool) {
        // Active pool: Show CURRENT cumulative pity for the group
        const currentPity = categorySummary?.currentPity || 0;
        displayPity = currentPity;
        carriedPity = Math.max(0, currentPity - poolTotal);
        thisPoolPulls = poolTotal;
      } else {
        // Historical pool: Show LEFTOVER pity (built after the last 6-star)
        displayPity = poolTotal;
        if (poolItemsAll.length > 0) {
          // Find the most recent 6-star
          const lastSix = poolItemsAll.find(
            (r: any) => r.rarity >= 6 && !r.isFree,
          );
          if (lastSix) {
            thisPoolPulls = poolTotal - lastSix.poolTotalCount;
            displayPity = thisPoolPulls;
            carriedPity = 0;
          } else {
            // No 6-stars, so pity never reset.
            const oldest = poolItemsAll[poolItemsAll.length - 1];
            carriedPity = Math.max(
              0,
              oldest.pitySixCount - oldest.poolTotalCount,
            );
            thisPoolPulls = poolTotal;
            displayPity = carriedPity + thisPoolPulls;
          }
        }
      }

      if (displayPity > 0) {
        if (curY + 60 <= overviewBottomLimit) {
          // Check space
          ctx.save();
          ctx.fillStyle = "#f0f2f5"; // Soft gray background
          ctx.shadowColor = "rgba(0,0,0,0.02)";
          ctx.shadowBlur = 10;
          roundRect(ctx, curX, curY, colW, 60, 15, true);
          ctx.shadowBlur = 0;

          ctx.fillStyle = "#ccc"; // Lighter gray accent
          ctx.fillRect(curX, curY, 8, 60);

          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#888"; // Gray text
          ctx.font = "bold 22px NotoSansTCBold";
          const paddedText =
            carriedPity > 0 && thisPoolPulls > 0
              ? (
                  tr?.("gacha_log_canvas_PaddedCountSplit") ??
                  "已墊 <carried> + <pool> 抽"
                )
                  .replace("<carried>", String(carriedPity))
                  .replace("<pool>", String(thisPoolPulls))
              : (
                  tr?.("gacha_log_canvas_PaddedCount") ??
                  "已墊 <hardCount> 抽"
                ).replace("<hardCount>", String(displayPity));
          ctx.fillText(paddedText, curX + colW / 2, curY + 30);

          const paddedTimeText = formatSmallGachaTime(
            getPoolLatestGachaTs(group.pId),
          );
          if (paddedTimeText) {
            ctx.textAlign = "right";
            ctx.textBaseline = "alphabetic";
            ctx.fillStyle = "#b0b5bf";
            ctx.font = "15px NotoSans";
            ctx.fillText(paddedTimeText, curX + colW - 12, curY + 52);
          }
          ctx.restore();
          curY += 60 + 15;
        }
      }
    }

    // ------------------------------------

    // Items (6★ and Free Blocks)
    let itemColIdx = i; // tracks current rendering column for single-pool overflow
    for (const item of group.items) {
      const neededH = item.isExpeditedBlock ? 60 : rectH;
      // Overflow into the next column (standard/beginner single-pool spread)
      if (curY + neededH > overviewBottomLimit) {
        if (isSinglePoolSpread && itemColIdx < 2) {
          itemColIdx++;
          curX = padding + itemColIdx * (colW + cardGap);
          curY = listY;
        } else {
          if (!item.isExpeditedBlock) break;
          continue;
        }
      }

      if (item.isExpeditedBlock) {
        // Render Yellow Free Pull Card
        ctx.save();
        ctx.fillStyle = "#fffbeb";
        ctx.shadowColor = "rgba(0,0,0,0.02)";
        ctx.shadowBlur = 10;
        roundRect(ctx, curX, curY, colW, 60, 15, true);
        ctx.shadowBlur = 0;

        ctx.fillStyle = "#ffcc00";
        ctx.fillRect(curX, curY, 8, 60);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#d97706";
        ctx.font = "bold 22px NotoSansTCBold";
        const freeText = (
          tr?.("gacha_log_canvas_FreePullSummary") ??
          "已使用 <count> 抽加急尋訪"
        ).replace("<count>", String(item.count));
        ctx.fillText(freeText, curX + colW / 2, curY + 30);

        const freeTimeText = formatSmallGachaTime(item.gachaTs);
        if (freeTimeText) {
          ctx.textAlign = "right";
          ctx.textBaseline = "alphabetic";
          ctx.fillStyle = "#b0b5bf";
          ctx.font = "16px NotoSans";
          ctx.fillText(freeTimeText, curX + colW - 12, curY + 52);
        }
        ctx.restore();
        curY += 60 + 15;
        continue;
      }

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
        try {
          const icon = await loadGachaIconImage(
            !!item.charId,
            String(item.charId || item.weaponId),
          );
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
        const textWidth = ctx.measureText(nameText).width; // Use nameText for measurement
        drawOffRateBadge(
          ctx,
          centerX + 60 + textWidth + 30, // Keep original X calculation
          curY + rectH / 2 + 2, // Keep original Y calculation
          22, // Keep original size
          isEn,
        );
      }

      ctx.textAlign = "right";
      if (item.isFree) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 26px NotoSansTCBold";
        ctx.textBaseline = "middle";
        ctx.fillText(
          tr("gacha_log_canvas_FreeRecruit"),
          curX + colW - 25,
          curY + rectH / 2,
        );
        ctx.textBaseline = "alphabetic";
      } else {
        // Display the banner-specific total count
        ctx.fillStyle = "#ff7100";
        ctx.font = "bold 34px NotoSansTCBold";

        ctx.fillText(
          `${item.pitySixCount}`,
          curX + colW - 25,
          curY + rectH / 2 - 5,
        );

        ctx.fillStyle = "#aaa";
        ctx.font = "20px NotoSans";
        ctx.fillText(
          tr("gacha_log_canvas_TotalCount").replace(
            "<pTotal>",
            String(item.poolTotalCount),
          ),
          curX + colW - 25,
          curY + rectH / 2 + 25,
        );
      }

      const itemTimeText = formatSmallGachaTime(item.gachaTs);
      if (itemTimeText) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#b0b5bf";
        ctx.font = "16px NotoSans";
        ctx.fillText(itemTimeText, curX + colW - 14, curY + rectH - 10);
      }

      curY += rectH + 15;
    }
  }

  await drawQuickStrip(ctx, state);
}
