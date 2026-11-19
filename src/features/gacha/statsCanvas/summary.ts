import { SKRSContext2D } from "@napi-rs/canvas";
import moment from "moment";
import { getGachaPityGroupId } from "../../../utils/gachaPoolUtils";
import {
  GachaStatsBaseState,
  GachaSummaryResult,
  GachaType,
  getWinRateCounts,
  roundRect,
} from "./shared";

export interface CategoryTotals {
  nonFreeTotal: number;
  freeTotal: number;
  sixCount: number;
  sixPullCount: number;
  featured: number;
  winRateTotal: number;
}

/** Pity-group ids of the Joint pools in `pools` (they are their own group, keyed by pool id). */
function getJointGroupIds(pools: any[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const p of pools || []) {
    const poolType = String(p?.poolType || p?.type || "");
    const poolId = String(p?.poolId || p?.id || "");
    if (poolType.includes("Joint") || poolId.startsWith("joint_")) {
      ids.add(getGachaPityGroupId(p));
    }
  }
  return ids;
}

/**
 * Totals shown on the overview summary cards for one category. Joint pools are
 * listed in (and paged with) the limited-character overview, so their pulls
 * count in its totals; they stay out of the up/off-rate figures because no
 * featured verdict is made for them.
 */
export function sumCategoryTotals(
  type: GachaType,
  groupStats: Record<string, any>,
  pools?: any[],
): CategoryTotals {
  const out: CategoryTotals = {
    nonFreeTotal: 0,
    freeTotal: 0,
    sixCount: 0,
    sixPullCount: 0,
    featured: 0,
    winRateTotal: 0,
  };
  const jointIds = type === "limited_char" ? getJointGroupIds(pools) : null;
  for (const [gid, s] of Object.entries(groupStats || {})) {
    const sObj = s as any;
    const isJoint =
      !!jointIds && (jointIds.has(gid) || gid.startsWith("joint_"));
    let isMatch = false;
    if (type === "weapon") {
      isMatch = true;
    } else if (type === "limited_char") {
      isMatch = gid === "SpecialShared" || isJoint;
    } else if (type === "rerun_char") {
      isMatch = gid === "RerunShared";
    } else if (type === "standard_char") {
      isMatch = gid.startsWith("Standard");
    } else if (type === "beginner_char") {
      isMatch = gid === "Beginner";
    }
    if (!isMatch) continue;

    out.nonFreeTotal += sObj.nonFreeTotal || 0;
    out.freeTotal += sObj.freeTotal || 0;
    out.sixCount += sObj.sixStarCount || 0;
    out.sixPullCount += sObj.sixStarPullCount || 0;

    // Win rate in overview (Limited, Rerun or Weapon); never from Joint pools
    if (
      !isJoint &&
      (type === "limited_char" || type === "rerun_char" || type === "weapon") &&
      sObj.poolFeaturedSixMap
    ) {
      const counts = getWinRateCounts(sObj);
      out.featured += counts.featured;
      out.winRateTotal += counts.total;
    }
  }
  return out;
}

/** Header, branding and the three summary cards. */
export function drawSummary(
  ctx: SKRSContext2D,
  state: GachaStatsBaseState,
): GachaSummaryResult {
  const {
    data,
    stats,
    tr,
    type,
    selectedPoolId,
    width,
    padding,
    baseType,
    visualGroups,
  } = state;
  // 2. Header
  ctx.fillStyle = "#111";
  ctx.font = "bold 80px NotoSansTCBold";
  ctx.textAlign = "left";
  ctx.fillText(
    tr("gacha_log_stats_Title", {
      uid: data.info.nickname || data.info.uid || stats.uid,
    }),
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
    type === "rerun_char"
      ? tr("gacha_log_stats_RerunCharPool")
      : type === "weapon"
        ? tr("gacha_log_stats_WeaponPool")
        : type === "limited_char"
          ? tr("gacha_log_stats_LimitedCharPool")
          : tr("gacha_log_stats_StandardCharPool");
  const recordDate = data.info.export_timestamp
    ? moment(data.info.export_timestamp).format("YYYY/MM/DD HH:mm")
    : moment().format("YYYY/MM/DD HH:mm");
  ctx.fillText(`${typeLabel} — ${recordDate}`, padding, 210);

  // 3. Summary Area (Horizontal Cards)
  const summaryY = 280;
  const summaryH = 220;
  const cardGap = 40;
  const cardW = (width - padding * 2 - cardGap * 2) / 3;

  // Filter total pulls by current pool group
  // For Character limited, we should only sum history from SpecialShared group
  const groupStats = stats[baseType].summary;
  // Specific pool values for header
  let specificPoolTotal = 0;
  let specificPoolFree = 0;

  // Overview: Sum relevant groups in category
  const totals = sumCategoryTotals(
    type,
    groupStats,
    (type === "weapon" ? stats.weapon.pools : stats.char.pools) as any[],
  );
  const categoryNonFreeTotal = totals.nonFreeTotal;
  const categoryFreeTotal = totals.freeTotal;
  const categorySixPullCount = totals.sixPullCount; // Only non-free
  const featuredSixCount = totals.featured;
  const winRateSixCount = totals.winRateTotal; // All 6★ incl. free, same basis as featuredSixCount

  let poolSixStarPullCount = 0;
  let poolFeaturedSixCount = 0;

  if (selectedPoolId) {
    const pool = (
      type === "weapon" ? stats.weapon.pools : stats.char.pools
    ).find((p: any) => p.id === selectedPoolId);

    specificPoolTotal = pool ? pool.total || 0 : 0;
    specificPoolFree = pool ? pool.freeCount || 0 : 0;
    poolSixStarPullCount = pool ? pool.sixStarPullCount || 0 : 0;
    poolFeaturedSixCount = pool ? pool.featuredSixCount || 0 : 0;
  }

  const rateUpWinRate = selectedPoolId
    ? poolSixStarPullCount > 0
      ? ((poolFeaturedSixCount / poolSixStarPullCount) * 100).toFixed(2) + "%"
      : (tr?.("gacha_log_canvas_NoData") ?? "未有資料")
    : winRateSixCount > 0
      ? ((featuredSixCount / winRateSixCount) * 100).toFixed(2) + "%"
      : (tr?.("gacha_log_canvas_NoData") ?? "未有資料");

  // Determine activeCategoryPity for headers
  const mainActiveGroup = visualGroups[0];
  const gIdMain =
    mainActiveGroup?.gId || (type === "weapon" ? "" : "SpecialShared");
  const mainPityData = groupStats[gIdMain] || {};
  const activeCategoryPity = mainPityData.currentPity || 0;

  const mainSummary = [
    {
      label: tr?.("gacha_log_canvas_TotalPulls") ?? "總累計抽數",
      value: String(categoryNonFreeTotal),
      subValue: categoryFreeTotal > 0 ? `+ ${categoryFreeTotal}` : "",
      icon: "📊",
    },
    {
      label: selectedPoolId
        ? (tr?.("gacha_log_canvas_CurrentTotal") ?? "當期總抽數")
        : (tr?.("gacha_log_canvas_SixStarRate") ?? "6星出率 (含保底)"),
      value: String(selectedPoolId ? specificPoolTotal : categoryNonFreeTotal),
      subValue:
        (selectedPoolId ? specificPoolFree : categoryFreeTotal) > 0
          ? `+ ${selectedPoolId ? specificPoolFree : categoryFreeTotal}`
          : "",
      icon: selectedPoolId ? "📅" : "✨",
    },
    {
      label:
        type === "limited_char" || type === "rerun_char"
          ? (tr?.("gacha_log_canvas_UpCharWinRate") ?? "UP角色不歪率")
          : type === "weapon"
            ? (tr?.("gacha_log_canvas_UpWeaponWinRate") ?? "UP武器不歪率")
            : "",
      value:
        type === "limited_char" || type === "rerun_char" || type === "weapon"
          ? rateUpWinRate
          : "",
      subValue: "",
      icon:
        type === "limited_char" || type === "rerun_char" || type === "weapon"
          ? "💍"
          : "",
      hidden:
        type !== "limited_char" && type !== "rerun_char" && type !== "weapon",
    },
  ];

  // If in Overview mode, we actually want Card 2 to be the 6-star rate
  if (!selectedPoolId) {
    mainSummary[1].value =
      categoryNonFreeTotal > 0
        ? ((categorySixPullCount / categoryNonFreeTotal) * 100).toFixed(2) + "%"
        : "0.00%";
    mainSummary[1].subValue = ""; // No + Expedited on rate card
  }

  mainSummary.forEach((s: any, i) => {
    if (s.hidden) return;
    const x = padding + i * (cardW + cardGap);
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.05)";
    ctx.shadowBlur = 15;
    roundRect(ctx, x, summaryY, cardW, summaryH, 30, true);
    ctx.shadowBlur = 0;

    ctx.textAlign = "center";
    ctx.fillStyle = "#111";
    ctx.font = "bold 80px NotoSansTCBold";
    const valText = s.value;
    const subText = (s as any).subValue || "";

    if (subText) {
      const valW = ctx.measureText(valText).width;
      ctx.font = "bold 40px NotoSansTCBold";
      const subW = ctx.measureText(subText).width;
      const totalW = valW + 10 + subW;
      const startX = x + cardW / 2 - totalW / 2;

      ctx.textAlign = "left";
      ctx.font = "bold 80px NotoSansTCBold";
      ctx.fillText(valText, startX, summaryY + 110);
      ctx.fillStyle = "#888";
      ctx.font = "bold 40px NotoSansTCBold";
      ctx.fillText("+ ", startX + valW + 5, summaryY + 110);
      ctx.fillStyle = "#ffcc00";
      ctx.fillText(
        subText.replace("+ ", ""),
        startX + valW + 35,
        summaryY + 110,
      );
    } else {
      ctx.fillText(valText, x + cardW / 2, summaryY + 110);
    }

    ctx.textAlign = "center";
    ctx.fillStyle = "#999";
    ctx.font = "32px NotoSans";
    ctx.fillText(s.label, x + cardW / 2, summaryY + 170);
  });

  return { summaryY, summaryH, cardGap, specificPoolTotal, specificPoolFree };
}
