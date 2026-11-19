import { createCanvas, loadImage } from "@napi-rs/canvas";
import path from "path";
import { CustomDatabase } from "../../../utils/Database";
import {
  getGachaPityGroupId,
  isGachaPoolInCategory,
  paginateGachaOverviewPools,
} from "../../../utils/gachaPoolUtils";
import { getPoolMetadata } from "../gachaApi";
import { GachaLogData } from "../gachaTypes";
import { drawSummary } from "./summary";
import { drawOverview } from "./overview";
import { drawDetail } from "./detail";
import {
  GachaStatsBaseState,
  GachaStatsState,
  GachaType,
  normalizeGachaText,
  parseGachaTs,
} from "./shared";

export async function drawGachaStats(
  data: GachaLogData,
  stats: any,
  tr: any,
  type: GachaType = "limited_char",
  selectedPoolId?: string,
  page: number = 0,
  db?: CustomDatabase,
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
  let height = 1400;
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
  const cachedPoolBannerMap = new Map<string, string>();
  for (const p of poolStats.pools || []) {
    const bannerUrl = String((p as any)?.bannerUrl || "").trim();
    if (p?.id && bannerUrl) cachedPoolBannerMap.set(String(p.id), bannerUrl);
  }

  const getPoolPaddedCount = (poolId: string, groupId: string): number => {
    const categoryStats = stats[type === "weapon" ? "weapon" : "char"];
    const categorySummary = categoryStats.summary?.[groupId];
    const poolTotal = categorySummary?.poolTotalMap?.[poolId] || 0;
    const newestPoolId =
      type === "rerun_char"
        ? categoryStats.pools?.find((p: any) => p.type?.includes("Rerun"))?.id
        : categoryStats.pools?.[0]?.id;

    if (poolId === newestPoolId) {
      return Math.max(0, categorySummary?.currentPity || 0);
    }

    const poolItemsAll = categoryStats.history.filter(
      (r: any) => r.poolId === poolId,
    );
    let displayPity = poolTotal;

    if (poolItemsAll.length > 0) {
      const lastSix = poolItemsAll.find((r: any) => r.rarity >= 6 && !r.isFree);
      if (lastSix) {
        displayPity = poolTotal - lastSix.poolTotalCount;
      } else {
        const oldest = poolItemsAll[poolItemsAll.length - 1];
        const initial = Math.max(
          0,
          oldest.pitySixCount - oldest.poolTotalCount,
        );
        displayPity = initial + poolTotal;
      }
    }

    return Math.max(0, displayPity);
  };

  const getPoolSixStarSummary = (poolId: string): any[] => {
    const poolSixItems = history.filter(
      (item: any) =>
        item.poolId === poolId &&
        Number(item.rarity || 0) >= 6 &&
        !item.isExpeditedBlock,
    );

    const sixMap = new Map<string, any>();
    for (const item of poolSixItems) {
      const key = String(
        item.charId || item.weaponId || item.name || "unknown",
      );
      const prev = sixMap.get(key);
      if (prev) {
        prev.count += 1;
        prev.latestTs = Math.max(
          prev.latestTs || 0,
          parseGachaTs(item.gachaTs),
        );
        prev.isOffRate = prev.isOffRate || !!item.isOffRate;
      } else {
        sixMap.set(key, {
          key,
          name: item.name,
          charId: item.charId,
          weaponId: item.weaponId,
          count: 1,
          latestTs: parseGachaTs(item.gachaTs),
          isOffRate: !!item.isOffRate,
        });
      }
    }

    return Array.from(sixMap.values()).sort((a, b) => b.count - a.count);
  };

  const getPoolLatestGachaTs = (poolId?: string): any => {
    if (!poolId) return undefined;
    const rec = history.find((item: any) => item.poolId === poolId);
    return rec?.gachaTs;
  };

  const poolBannerUrlMap = new Map<string, string>();
  const fetchPoolBannerUrl = async (
    poolId: string,
  ): Promise<string | undefined> => {
    if (!poolId) return undefined;
    // In-process cache: avoids repeated DB lookups within one render
    if (poolBannerUrlMap.has(poolId)) return poolBannerUrlMap.get(poolId);

    // 1. Global DB cache (persists across restarts, shared across all users)
    if (db) {
      const meta = await getPoolMetadata(db, poolId, apiLang, apiServerId);
      const bannerUrl =
        meta?.up6_image || meta?.up5_image || meta?.banner_image;
      if (bannerUrl) {
        poolBannerUrlMap.set(poolId, bannerUrl);
        return bannerUrl;
      }
    }

    // 2. Banner stored inside poolStats.pools (from import time)
    const cachedBanner = cachedPoolBannerMap.get(poolId);
    if (cachedBanner) {
      poolBannerUrlMap.set(poolId, cachedBanner);
      return cachedBanner;
    }

    // 3. Current selected pool from already-fetched API data
    if (selectedPoolId === poolId && poolApiData?.up6_image) {
      poolBannerUrlMap.set(poolId, poolApiData.up6_image);
      return poolApiData.up6_image;
    }

    return undefined;
  };

  const drawBannerContain = (
    img: any,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    const aspect = img.width / img.height;
    const boxAspect = w / h;
    let drawW = w;
    let drawH = h;
    let drawX = x;
    let drawY = y;

    if (aspect > boxAspect) {
      drawW = w;
      drawH = w / aspect;
      drawY = y + (h - drawH) / 2;
    } else {
      drawH = h;
      drawW = h * aspect;
      drawX = x + (w - drawW) / 2;
    }
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  };

  // 1. Grouping for Visuals
  const visualGroups: {
    title: string;
    items: any[];
    gId: string;
    pId?: string;
  }[] = [];

  if (!selectedPoolId) {
    const pools = paginateGachaOverviewPools(
      type === "weapon" ? stats.weapon.pools : stats.char.pools,
      type,
      page,
    ).pools;

    for (const p of pools) {
      const items = history.filter(
        (item: any) =>
          item.poolId === p.id &&
          (Number(item.rarity || 0) >= 6 || item.isExpeditedBlock),
      );

      const gId = getGachaPityGroupId(p);

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
      (item: any) =>
        item.poolId === selectedPoolId && Number(item.rarity || 0) >= 4,
    );
    const pool = (
      type === "weapon" ? stats.weapon.pools : stats.char.pools
    ).find((p: any) => p.id === selectedPoolId);

    const gId = getGachaPityGroupId(
      pool || {
        id: selectedPoolId,
        type: type === "weapon" ? "WeaponPool" : "",
      },
    );

    const gSummary = stats[type === "weapon" ? "weapon" : "char"].summary;
    const pTotal = gSummary[gId]?.poolTotalMap?.[selectedPoolId] || 0;

    visualGroups.push({
      title: normalizeGachaText(pool?.name || tr("gacha_log_canvas_ListLabel")),
      items,
      gId,
      pId: selectedPoolId,
    });
  }

  // Dynamically expand canvas height to fit all 6★ items in overview mode.
  // Overhead estimate: listY(580) + column header(100) + pity placeholder(85) + padded bar(75) = 840
  // Each 6★ card: rectH(110) + gap(15) = 125px
  // Bottom reserve: quick strip(240) + margin(60) = 300
  if (!selectedPoolId && visualGroups.length > 0) {
    const OVERHEAD_PER_COL = 840;
    const CARD_SPACING = 125;
    const BOTTOM_RESERVE = 300;
    let maxColH = 0;
    for (const group of visualGroups) {
      const sixItemCount = group.items.filter(
        (item: any) => !item.isExpeditedBlock,
      ).length;
      maxColH = Math.max(
        maxColH,
        OVERHEAD_PER_COL + sixItemCount * CARD_SPACING,
      );
    }
    height = Math.max(height, maxColH + BOTTOM_RESERVE);
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#f4f6f8";
  ctx.fillRect(0, 0, width, height);

  // Draw bottom-right decoration FIRST (behind all content)
  try {
    const bgRbImg = await loadImage(
      path.join(__dirname, "../../../assets/bg-rb.png"),
    );
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.drawImage(bgRbImg, width - bgRbImg.width, height - bgRbImg.height);
    ctx.restore();
  } catch (e) {
    console.error("[drawGachaStats] Error drawing bg-rb.png", e);
  }


  const baseState: GachaStatsBaseState = {
    data,
    stats,
    tr,
    type,
    selectedPoolId,
    page,
    db,
    apiLang,
    apiServerId,
    isEn,
    width,
    height,
    padding,
    baseType,
    history,
    poolApiData,
    visualGroups,
    poolBannerUrlMap,
    getPoolPaddedCount,
    getPoolSixStarSummary,
    getPoolLatestGachaTs,
    drawBannerContain,
  };
  const { summaryY, summaryH, cardGap, specificPoolTotal, specificPoolFree } =
    drawSummary(ctx, baseState);

  // 4. History Groups
  const listY = summaryY + summaryH + 80;

  const categoryPoolsForQuick = (
    type === "weapon" ? stats.weapon.pools : stats.char.pools
  ).filter((p: any) => isGachaPoolInCategory(p, type));

  const shownPoolIds = new Set(visualGroups.map((g) => g.pId).filter(Boolean));
  const hiddenPoolsWithData = categoryPoolsForQuick.filter((p: any) => {
    if (shownPoolIds.has(p.id)) return false;
    return (
      (p.total || 0) > 0 ||
      (p.freeCount || 0) > 0 ||
      (p.sixStarPullCount || 0) > 0
    );
  });
  const quickPoolsForOverview = !selectedPoolId
    ? hiddenPoolsWithData.slice(0, 5)
    : [];
  const quickStripEnabled = quickPoolsForOverview.length > 0;
  const overviewBottomLimit = quickStripEnabled ? height - 240 : height - 80;

  const bannerCandidatePoolIds = new Set<string>();
  visualGroups.forEach((g) => {
    if (g.pId) bannerCandidatePoolIds.add(g.pId);
  });
  quickPoolsForOverview.forEach((p: any) => bannerCandidatePoolIds.add(p.id));
  if (selectedPoolId) bannerCandidatePoolIds.add(selectedPoolId);

  await Promise.all(
    Array.from(bannerCandidatePoolIds).map((poolId) =>
      fetchPoolBannerUrl(poolId),
    ),
  );

  const state: GachaStatsState = {
    ...baseState,
    listY,
    cardGap,
    specificPoolTotal,
    specificPoolFree,
    quickPoolsForOverview,
    hiddenPoolsWithData,
    overviewBottomLimit,
  };
  if (!selectedPoolId) {
    await drawOverview(ctx, state);
  } else {
    await drawDetail(ctx, state);
  }

  return canvas.toBuffer("image/webp", 90);
}
