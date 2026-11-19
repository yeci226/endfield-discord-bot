import { SKRSContext2D } from "@napi-rs/canvas";
import { getGachaPityGroupId } from "../../../utils/gachaPoolUtils";
import { fetchImage } from "../../../utils/canvasUtils";
import { loadGachaIconImage } from "../iconLoader";
import {
  GachaStatsState,
  normalizeGachaText,
  formatSmallGachaTime,
  roundRect,
  fillDynamicText,
  drawOffRateBadge,
} from "./shared";

/** Strip of small cards for older pools at the bottom of the overview. */
export async function drawQuickStrip(
  ctx: SKRSContext2D,
  state: GachaStatsState,
): Promise<void> {
  const {
    tr,
    isEn,
    width,
    height,
    padding,
    poolBannerUrlMap,
    quickPoolsForOverview,
    hiddenPoolsWithData,
    getPoolPaddedCount,
    getPoolSixStarSummary,
    getPoolLatestGachaTs,
  } = state;
  if (quickPoolsForOverview.length > 0) {
    const quickTitleY = height - 205;
    const quickCardY = height - 178;
    const quickCardH = 160;
    const quickGap = 16;
    const quickCardW = (width - padding * 2 - quickGap * 4) / 5;

    ctx.textAlign = "left";
    ctx.fillStyle = "#666";
    ctx.font = "bold 30px NotoSansTCBold";
    ctx.fillText(
      tr?.("gacha_log_canvas_HistoryQuickTitle") ?? "過往卡池速覽",
      padding,
      quickTitleY,
    );

    for (let idx = 0; idx < quickPoolsForOverview.length; idx++) {
      const p = quickPoolsForOverview[idx];
      const x = padding + idx * (quickCardW + quickGap);
      const gId = getGachaPityGroupId(p);
      const nonFree = p.total || 0;
      const free = p.freeCount || 0;
      const paddedCount = getPoolPaddedCount(p.id, gId);
      const sixSummary = getPoolSixStarSummary(p.id);
      const quickTimeText = formatSmallGachaTime(getPoolLatestGachaTs(p.id));

      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "rgba(0,0,0,0.04)";
      ctx.shadowBlur = 10;
      roundRect(ctx, x, quickCardY, quickCardW, quickCardH, 14, true);
      ctx.shadowBlur = 0;

      const quickBannerUrl = poolBannerUrlMap.get(p.id);
      let titleMaxWidth = quickCardW - 24;
      if (quickBannerUrl) {
        try {
          const bannerImg = await fetchImage(
            quickBannerUrl,
            `pool_quick_${p.id}`,
          );
          const bHeight = 52;
          const bWidth = quickCardW;
          const bX = x;
          const bY = quickCardY;

          // Quick overview cards should prioritize full-width visual impact.
          // Use cover-style crop instead of contain so the banner always spans the card width.
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(bX, bY);
          ctx.lineTo(bX + bWidth, bY);
          ctx.lineTo(bX + bWidth, bY + bHeight - 5);
          ctx.quadraticCurveTo(
            bX + bWidth,
            bY + bHeight,
            bX + bWidth - 5,
            bY + bHeight,
          );
          ctx.lineTo(bX + 5, bY + bHeight);
          ctx.quadraticCurveTo(bX, bY + bHeight, bX, bY + bHeight - 5);
          ctx.closePath();
          ctx.clip();
          const imgAspect = bannerImg.width / bannerImg.height;
          const boxAspect = bWidth / bHeight;
          let drawW = bWidth;
          let drawH = bHeight;
          let drawX = bX;
          let drawY = bY;
          if (imgAspect > boxAspect) {
            drawH = bHeight;
            drawW = bHeight * imgAspect;
            drawX = bX - (drawW - bWidth) / 2;
          } else {
            drawW = bWidth;
            drawH = bWidth / imgAspect;
            drawY = bY - (drawH - bHeight) / 2;
          }
          ctx.drawImage(bannerImg, drawX, drawY, drawW, drawH);
          ctx.restore();

          ctx.save();
          ctx.textAlign = "left";
          ctx.fillStyle = "#111";
          fillDynamicText(
            ctx,
            `I ${normalizeGachaText(p.name)}`,
            bX + 14,
            quickCardY + 33,
            bWidth - 24,
            24,
            true,
          );
          ctx.restore();

          titleMaxWidth = 0;
        } catch (e) {}
      }

      // Draw the left accent strip after banner so it visually overlays the banner area.
      ctx.fillStyle = "#d4d7dd";
      ctx.fillRect(x, quickCardY, 6, quickCardH);

      if (titleMaxWidth > 0) {
        ctx.textAlign = "left";
        ctx.fillStyle = "#111";
        ctx.font = "bold 24px NotoSansTCBold";
        fillDynamicText(
          ctx,
          normalizeGachaText(p.name),
          x + 14,
          quickCardY + 30,
          titleMaxWidth,
          22,
          true,
        );
      }

      // Keep quick total line consistent with top cards: Prefix + count + suffix.
      let summaryX = x + 14;
      const summaryY = quickCardY + 52;
      const totalPrefix = tr("gacha_log_canvas_Total_Prefix").trim();
      const totalSuffix = tr("gacha_log_canvas_Pulls_Suffix").trim();

      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#888";
      ctx.font = "16px NotoSans";
      ctx.fillText(totalPrefix, summaryX, summaryY);
      summaryX += ctx.measureText(totalPrefix).width + 6;

      ctx.fillStyle = "#444";
      ctx.font = "bold 18px NotoSansTCBold";
      ctx.fillText(String(nonFree), summaryX, summaryY);
      summaryX += ctx.measureText(String(nonFree)).width + 6;

      if (free > 0) {
        ctx.fillStyle = "#888";
        ctx.font = "15px NotoSans";
        ctx.fillText("+", summaryX, summaryY);
        summaryX += ctx.measureText("+").width + 6;

        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 17px NotoSansTCBold";
        ctx.fillText(String(free), summaryX, summaryY);
        summaryX += ctx.measureText(String(free)).width + 6;
      }

      ctx.fillStyle = "#888";
      ctx.font = "16px NotoSans";
      ctx.fillText(totalSuffix, summaryX, summaryY);

      if (sixSummary.length === 0) {
        ctx.fillStyle = "#999";
        ctx.font = "18px NotoSans";
        ctx.textAlign = "center";
        ctx.fillText(
          tr?.("gacha_log_canvas_HistoryQuickNoSix") ?? "尚未抽到 6 星",
          x + quickCardW / 2,
          quickCardY + 108,
        );
        continue;
      }

      const useTwoRows = sixSummary.length > 3;
      const maxDisplay = useTwoRows ? 6 : 3;
      const displayList = sixSummary.slice(0, maxDisplay);
      const perRow = useTwoRows
        ? 3
        : Math.max(1, Math.min(3, displayList.length));
      const iconSize = useTwoRows ? 28 : 48;
      const rowGap = useTwoRows ? 10 : 0;
      const sidePadding = 14;
      const contentW = quickCardW - sidePadding * 2;
      const slotW = contentW / perRow;
      const iconStartY = useTwoRows ? quickCardY + 74 : quickCardY + 86;

      for (let i = 0; i < displayList.length; i++) {
        const row = useTwoRows ? Math.floor(i / 3) : 0;
        const col = useTwoRows ? i % 3 : i;
        const slotCenterX = x + sidePadding + col * slotW + slotW / 2;
        const countAreaW = useTwoRows ? 26 : 34;
        const clusterW = iconSize + 6 + countAreaW;
        const cellX = slotCenterX - clusterW / 2;
        const cellY = iconStartY + row * (iconSize + rowGap);
        const iconX = cellX + iconSize / 2;
        const iconY = cellY + iconSize / 2;
        const sixItem = displayList[i];

        ctx.beginPath();
        ctx.arc(iconX, iconY, iconSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = "#eceff3";
        ctx.fill();

        if (sixItem.charId || sixItem.weaponId) {
          try {
            const icon = await loadGachaIconImage(
              !!sixItem.charId,
              String(sixItem.charId || sixItem.weaponId),
            );
            ctx.save();
            ctx.beginPath();
            ctx.arc(iconX, iconY, iconSize / 2 - 1, 0, Math.PI * 2);
            ctx.clip();

            const aspect = icon.width / icon.height;
            let drawW = iconSize;
            let drawH = iconSize;
            if (aspect > 1) {
              drawW = drawH * aspect;
            } else {
              drawH = drawW / aspect;
            }

            ctx.drawImage(
              icon,
              iconX - drawW / 2,
              iconY - drawH / 2,
              drawW,
              drawH,
            );
            ctx.restore();
          } catch (e) {}
        }

        if (sixItem.isOffRate) {
          drawOffRateBadge(
            ctx,
            iconX + iconSize / 2 - 2,
            iconY - iconSize / 2 + 2,
            useTwoRows ? 8 : 10,
            isEn,
          );
        }

        ctx.fillStyle = "#666";
        ctx.font = `bold ${useTwoRows ? 17 : 22}px NotoSansTCBold`;
        ctx.textAlign = "left";
        ctx.fillText(
          `x${sixItem.count}`,
          cellX + iconSize + 6,
          cellY + iconSize / 2 + 7,
        );
      }

      if (sixSummary.length > maxDisplay) {
        const remain = sixSummary.length - maxDisplay;
        ctx.textAlign = "right";
        ctx.fillStyle = "#888";
        ctx.font = "16px NotoSans";
        ctx.fillText(
          `+${remain}`,
          x + quickCardW - 10,
          quickCardY + quickCardH - 28,
        );
      }

      if (quickTimeText) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#b0b5bf";
        ctx.font = "15px NotoSans";
        ctx.fillText(
          quickTimeText,
          x + quickCardW - 10,
          quickCardY + quickCardH - 10,
        );
      }
    }

    if (hiddenPoolsWithData.length > quickPoolsForOverview.length) {
      const remain =
        hiddenPoolsWithData.length - quickPoolsForOverview.length;
      ctx.textAlign = "right";
      ctx.fillStyle = "#888";
      ctx.font = "22px NotoSans";
      ctx.fillText(
        (
          tr?.("gacha_log_canvas_HistoryQuickMore") ?? "其餘 <count> 池"
        ).replace("<count>", String(remain)),
        width - padding,
        quickTitleY,
      );
    }
  }
}
