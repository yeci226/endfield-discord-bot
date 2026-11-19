import { SKRSContext2D } from "@napi-rs/canvas";
import moment from "moment";
import { fetchImageTimed, loadGachaIconImage } from "../iconLoader";
import {
  GachaStatsState,
  ITEMS_PER_PAGE,
  getDetailedPageCount,
  normalizeGachaText,
  roundRect,
  fillDynamicText,
  drawOffRateBadge,
} from "./shared";

/** Detail view of one pool: paged grid of 4+ star pulls. */
export async function drawDetail(
  ctx: SKRSContext2D,
  state: GachaStatsState,
): Promise<void> {
  const {
    stats,
    tr,
    type,
    selectedPoolId,
    page,
    isEn,
    width,
    height,
    padding,
    visualGroups,
    listY,
    specificPoolTotal,
    specificPoolFree,
    poolBannerUrlMap,
    drawBannerContain,
  } = state;
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
    const newestPoolId =
      type === "rerun_char"
        ? poolList.find((p: any) => p.type?.includes("Rerun"))?.id
        : poolList[0]?.id;
    return selectedPoolId === newestPoolId;
  })();

  const allItems = group.items;
  const poolItemsAll = stats[
    type === "weapon" ? "weapon" : "char"
  ].history.filter((r: any) => r.poolId === group.pId);
  const detailedCategorySummary =
    stats[type === "weapon" ? "weapon" : "char"].summary[
      group.gId || "unknown"
    ];
  const detailedPoolTotal =
    detailedCategorySummary?.poolTotalMap?.[group.pId || ""] || 0;
  let initialPaddedCount = 0;
  if (poolItemsAll.length > 0) {
    const oldest = poolItemsAll[poolItemsAll.length - 1];
    initialPaddedCount = Math.max(
      0,
      oldest.pitySixCount - oldest.poolTotalCount,
    );
  } else if ((group as any).isNewest) {
    // Very rare: user views detailed mode of a pool with <10 pulls and no 4-stars.
    initialPaddedCount = Math.max(
      0,
      (detailedCategorySummary?.currentPity || 0) - detailedPoolTotal,
    );
  }

  const totalPages = getDetailedPageCount(
    allItems,
    showPlaceholder,
    initialPaddedCount > 0,
  );

  // Calculate how many items to skip/take based on previous pages' layout
  let skipped = 0;
  for (let p = 0; p < page; p++) {
    const pIsFirst = p === 0;
    const pIsLast = p === totalPages - 1;
    const slots =
      ITEMS_PER_PAGE -
      (pIsFirst && showPlaceholder ? 1 : 0) -
      (pIsLast && initialPaddedCount > 0 ? 1 : 0);
    skipped += slots;
  }

  const placeholderOnThisPage = showPlaceholder && page === 0;
  const paddedCardOnThisPage =
    initialPaddedCount > 0 && page === totalPages - 1;
  const slotsOnThisPage =
    ITEMS_PER_PAGE -
    (placeholderOnThisPage ? 1 : 0) -
    (paddedCardOnThisPage ? 1 : 0);

  const pagedItems = allItems.slice(skipped, skipped + slotsOnThisPage);

  let currentX = centerPadding;
  let currentY = listY;

  // Detailed Pool Group Header
  ctx.textAlign = "left";
  const poolTitle = normalizeGachaText(group.title);
  const detailedBannerUrl =
    group.pId ? poolBannerUrlMap.get(group.pId) : undefined;
  ctx.fillStyle = "#111";
  ctx.font = "bold 52px NotoSansTCBold";
  ctx.fillText("I", centerPadding, currentY);
  const detailFallbackTitle = `I ${poolTitle}`;

  let titleRight = centerPadding;
  if (detailedBannerUrl) {
    try {
      const bannerImg = await fetchImageTimed(
        detailedBannerUrl,
        `pool_detail_header_${group.pId || selectedPoolId || "current"}`,
      );
      const bHeight = 320;
      const bWidth = 980;
      const bX = centerPadding;
      const bY = currentY - 170;

      drawBannerContain(bannerImg, bX, bY, bWidth, bHeight);

      ctx.save();
      ctx.textAlign = "left";
      ctx.fillStyle = "#000";
      fillDynamicText(
        ctx,
        detailFallbackTitle,
        centerPadding + 15,
        currentY,
        bWidth - 26,
        50,
        true,
      );
      ctx.restore();

      titleRight = bX + bWidth;
    } catch (e) {}
  }

  if (!detailedBannerUrl) {
    ctx.fillText(detailFallbackTitle, centerPadding, currentY);
    titleRight = centerPadding + ctx.measureText(detailFallbackTitle).width;
  }

  let startX = titleRight + 20;
  let headerMetaY = currentY;
  if (startX > centerPadding + 980) {
    startX = centerPadding;
    headerMetaY = currentY + 36;
  }
  ctx.textBaseline = "alphabetic";

  const totalPrefix = tr("gacha_log_canvas_Total_Prefix").trim();
  const freeLabel = tr("gacha_log_canvas_FreeRecruit");
  const pullsSuffix = tr("gacha_log_canvas_Pulls_Suffix").trim();

  // "Total"
  ctx.fillStyle = "#888";
  ctx.font = "28px NotoSans";
  ctx.fillText(totalPrefix, startX, headerMetaY);
  startX += ctx.measureText(totalPrefix).width + 8;

  // Non-free count
  ctx.fillStyle = "#444";
  ctx.font = "bold 28px NotoSansTCBold";
  ctx.fillText(String(specificPoolTotal), startX, headerMetaY);
  startX += ctx.measureText(String(specificPoolTotal)).width + 8;

  if (specificPoolFree > 0) {
    // "+"
    ctx.fillStyle = "#888";
    ctx.font = "24px NotoSans";
    ctx.fillText("+", startX, headerMetaY);
    startX += ctx.measureText("+").width + 8;

    // Free count
    ctx.fillStyle = "#ffcc00";
    ctx.font = "bold 28px NotoSansTCBold";
    ctx.fillText(String(specificPoolFree), startX, headerMetaY);
    startX += ctx.measureText(String(specificPoolFree)).width + 8;

    // "Expedited"
    ctx.fillStyle = "#ffcc00";
    ctx.font = "28px NotoSans";
    ctx.fillText(freeLabel, startX, headerMetaY);
    startX += ctx.measureText(freeLabel).width + 8;
  }

  // "pulls"
  ctx.fillStyle = "#888";
  ctx.font = "28px NotoSans";
  ctx.fillText(pullsSuffix, startX, headerMetaY);

  currentY = headerMetaY + 70;

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

      const label =
        tr?.(locKey) ??
        (isSpark
          ? "剩餘 <hardRemaining> 抽可獲得當期信物"
          : "剩餘 <hardRemaining> 抽必得當期 6 星");
      ctx.fillText(
        label.replace("<hardRemaining>", String(hardRemaining)),
        pCenterX + pRadius + 10,
        currentY + itemH / 2 + 30,
      );
    }

    ctx.restore();

    currentX += itemW + gap;
  }
  // ------------------------------------

  for (const item of pagedItems) {
    const isSix = Number(item.rarity || 0) >= 6;
    const isFive = Number(item.rarity || 0) === 5;

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
      try {
        const icon = await loadGachaIconImage(
          !!item.charId,
          String(item.charId || item.weaponId),
        );
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
    if (item.isFree) {
      ctx.fillStyle = "#ffcc00";
      ctx.font = `bold 28px NotoSansTCBold`;
      ctx.textBaseline = "middle";
      ctx.fillText(
        tr?.("gacha_log_canvas_FreeRecruit") ?? "加急",
        curX + itemW - 15,
        curY + itemH / 2,
      );
      ctx.textBaseline = "alphabetic";
    } else {
      const displayPity = isSix ? item.pitySixCount : item.pityCount;
      // Pity Count
      ctx.fillStyle = isSix ? "#ff7100" : isFive ? "#ffcc00" : "#b04dff";
      ctx.font = `bold ${fontSize + 4}px NotoSansTCBold`;
      ctx.fillText(`${displayPity}`, curX + itemW - 15, curY + itemH / 2 - 5);
      // Pool Total Count (Non-free)
      ctx.fillStyle = "#888";
      ctx.font = `${subFontSize}px NotoSans`;
      ctx.fillText(
        `T${String(item.poolTotalCount)}`,
        curX + itemW - 15,
        curY + itemH / 2 + 25,
      );
    }

    currentX += itemW + gap;
  }

  // --- PADDED PULLS (Detailed Gray Card) ---
  // If we are on the LAST page, show padded pulls if any
  const isLastPage =
    page ===
    getDetailedPageCount(allItems, showPlaceholder, initialPaddedCount > 0) -
      1;

  if (isLastPage && initialPaddedCount > 0) {
    if (currentX + itemW > width - (centerPadding - padding + rightGutter)) {
      currentX = centerPadding;
      currentY += itemH + gap;
    }

    if (currentY + itemH <= height - 50) {
      ctx.save();
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.02)";
      ctx.shadowBlur = 10;
      roundRect(ctx, currentX, currentY, itemW, itemH, 15, true);
      ctx.shadowBlur = 0;

      ctx.fillStyle = "#ccc"; // Gray accent
      ctx.fillRect(currentX, currentY, 8, itemH);

      const dRadius = 40;
      const dCenterX = currentX + dRadius + 15;
      const dCenterY = currentY + itemH / 2;

      ctx.beginPath();
      ctx.arc(dCenterX, dCenterY, dRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#f0f2f5";
      ctx.fill();

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#999";
      ctx.font = "bold 50px NotoSansTCBold";
      ctx.fillText("⚓", dCenterX, dCenterY - 2);

      ctx.textAlign = "left";
      ctx.fillStyle = "#888";
      ctx.font = "bold 24px NotoSansTCBold";
      const detailedPaddedText =
        initialPaddedCount > 0 && detailedPoolTotal > 0
          ? (
              tr?.("gacha_log_canvas_PaddedCountSplit") ??
              "已墊 <carried> + <pool> 抽"
            )
              .replace("<carried>", String(initialPaddedCount))
              .replace("<pool>", String(detailedPoolTotal))
          : (
              tr?.("gacha_log_canvas_PaddedCount") ?? "已墊 <hardCount> 抽"
            ).replace(
              "<hardCount>",
              String(initialPaddedCount || detailedPoolTotal),
            );
      ctx.fillText(
        detailedPaddedText,
        dCenterX + dRadius + 10,
        currentY + itemH / 2,
      );
      ctx.restore();
    }
  }
}
