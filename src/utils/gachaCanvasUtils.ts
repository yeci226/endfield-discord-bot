import {
  createCanvas,
  GlobalFonts,
  CanvasRenderingContext2D,
  loadImage,
} from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
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

function parseGachaTs(rawTs: any): number {
  if (rawTs == null) return 0;
  if (typeof rawTs === "number") return rawTs;
  if (typeof rawTs === "string" && /^\d+$/.test(rawTs)) {
    return Number(rawTs);
  }
  const parsed = moment(rawTs);
  return parsed.isValid() ? parsed.valueOf() : 0;
}

function formatSmallGachaTime(rawTs: any): string {
  const ts = parseGachaTs(rawTs);
  if (!ts) return "";
  return moment(ts).format("YY/MM/DD HH:mm");
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
  includesPaddedCard: boolean = false,
): number {
  let effectiveItems = items.length;
  if (includesPlaceholder) effectiveItems += 1;
  if (includesPaddedCard) effectiveItems += 1;
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

  const resolveGroupIdForPool = (pool: any): string => {
    if (type === "weapon") return pool?.id || "";
    if (pool?.type?.includes("Beginner")) return "Beginner";
    if (pool?.type?.includes("Standard") || pool?.type?.includes("Classic")) {
      return `Standard_${pool.id}`;
    }
    return "SpecialShared";
  };

  const getPoolPaddedCount = (poolId: string, groupId: string): number => {
    const categoryStats = stats[type === "weapon" ? "weapon" : "char"];
    const categorySummary = categoryStats.summary?.[groupId];
    const poolTotal = categorySummary?.poolTotalMap?.[poolId] || 0;
    const newestPoolId = categoryStats.pools?.[0]?.id;

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
    if (poolBannerUrlMap.has(poolId)) return poolBannerUrlMap.get(poolId);

    const cachedBanner = cachedPoolBannerMap.get(poolId);
    if (cachedBanner) {
      poolBannerUrlMap.set(poolId, cachedBanner);
      return cachedBanner;
    }

    if (selectedPoolId === poolId && poolApiData?.up6_image) {
      poolBannerUrlMap.set(poolId, poolApiData.up6_image);
      return poolApiData.up6_image;
    }

    try {
      const res = await fetch(
        `https://ef-webview.gryphline.com/api/content?lang=${apiLang}&pool_id=${poolId}&server_id=${apiServerId}`,
      );
      if (!res.ok) return undefined;

      const json = await res.json();
      const pool = json?.data?.pool;
      const bannerUrl =
        pool?.up6_image || pool?.up5_image || pool?.banner_image;
      if (bannerUrl) {
        poolBannerUrlMap.set(poolId, bannerUrl);
        return bannerUrl;
      }
    } catch (e) {
      console.error(
        `[drawGachaStats] Failed to fetch banner for pool ${poolId}`,
        e,
      );
    }

    return undefined;
  };

  const loadGachaIconImage = async (
    isCharacter: boolean,
    rawId: string,
  ): Promise<any> => {
    const cid = String(rawId || "").replace("icon_", "");
    if (!cid) throw new Error("Missing icon id");

    const localDirs = [
      path.join(__dirname, "../assets/remote_cache"),
      path.join(__dirname, "../assets/cache"),
    ];

    const candidateNames = isCharacter
      ? [`icon_${cid}.png`, `icon_${cid}.webp`, `icon_${cid}.jpg`]
      : [
          `${cid}.png`,
          `${cid}.webp`,
          `${cid}.jpg`,
          `icon_${cid}.png`,
          `icon_${cid}.webp`,
          `icon_${cid}.jpg`,
        ];

    for (const dir of localDirs) {
      for (const fileName of candidateNames) {
        const localPath = path.join(dir, fileName);
        if (!fs.existsSync(localPath)) continue;
        try {
          return await loadImage(fs.readFileSync(localPath));
        } catch {}
      }
    }

    const iconUrl = isCharacter
      ? `https://endfieldtools.dev/assets/images/endfield/charicon/icon_${cid}.png`
      : `https://endfieldtools.dev/assets/images/endfield/itemicon/${cid}.png`;

    const cacheName = isCharacter ? `icon_${cid}` : cid;
    return await fetchImage(iconUrl, cacheName);
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
        (item: any) =>
          item.poolId === p.id &&
          (Number(item.rarity || 0) >= 6 || item.isExpeditedBlock),
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
      (item: any) =>
        item.poolId === selectedPoolId && Number(item.rarity || 0) >= 4,
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
    type === "weapon"
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
  // Aggregated Category Stats
  let categoryNonFreeTotal = 0;
  let categoryFreeTotal = 0;
  let categorySixCount = 0;
  let categorySixPullCount = 0; // Only non-free
  let featuredSixCount = 0;

  // Specific pool values for header
  let specificPoolTotal = 0;
  let specificPoolFree = 0;

  // Overview: Sum relevant groups in category
  for (const [gid, s] of Object.entries(groupStats)) {
    const sObj = s as any;
    let isMatch = false;
    if (type === "weapon") {
      isMatch = true;
    } else if (type === "limited_char") {
      isMatch = gid === "SpecialShared";
    } else if (type === "standard_char") {
      isMatch = gid.startsWith("Standard");
    } else if (type === "beginner_char") {
      isMatch = gid === "Beginner";
    }

    if (isMatch) {
      categoryNonFreeTotal += sObj.nonFreeTotal || 0;
      categoryFreeTotal += sObj.freeTotal || 0;
      categorySixCount += sObj.sixStarCount || 0;
      categorySixPullCount += sObj.sixStarPullCount || 0;

      // For Win Rate in Overview (Limited or Weapon)
      if (
        (type === "limited_char" || type === "weapon") &&
        sObj.poolFeaturedSixMap
      ) {
        Object.values(sObj.poolFeaturedSixMap).forEach((v: any) => {
          featuredSixCount += v || 0;
        });
      }
    }
  }

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
    : categorySixPullCount > 0
      ? ((featuredSixCount / categorySixPullCount) * 100).toFixed(2) + "%"
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
        type === "limited_char"
          ? (tr?.("gacha_log_canvas_UpCharWinRate") ?? "UP角色不歪率")
          : type === "weapon"
            ? (tr?.("gacha_log_canvas_UpWeaponWinRate") ?? "UP武器不歪率")
            : "",
      value: type === "limited_char" || type === "weapon" ? rateUpWinRate : "",
      subValue: "",
      icon: type === "limited_char" || type === "weapon" ? "💍" : "",
      hidden: type !== "limited_char" && type !== "weapon",
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

  // 4. History Groups
  const listY = summaryY + summaryH + 80;

  const categoryPoolsForQuick = (
    type === "weapon" ? stats.weapon.pools : stats.char.pools
  ).filter((p: any) => {
    if (type === "weapon") return p.type?.includes("Weapon");
    if (type === "standard_char")
      return p.type?.includes("Standard") && !p.name?.includes("新手");
    if (type === "beginner_char")
      return p.type?.includes("Beginner") || p.name?.includes("新手");
    return p.type?.includes("Special");
  });

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

  if (!selectedPoolId) {
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
      } else if ((gId === "SpecialShared" || type === "weapon") && i === 0) {
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
        const newestPoolId = poolList[0]?.id;
        const isNewestPool = group.pId === newestPoolId;

        let displayPity = 0;

        if (isNewestPool) {
          // Actve pool: Show CURRENT cumulative pity for the group
          displayPity = categorySummary?.currentPity || 0;
        } else {
          // Historical pool: Show LEFTOVER pity (built after the last 6-star)
          displayPity = poolTotal; // default if no prior pity
          if (poolItemsAll.length > 0) {
            // Find the most recent 6-star
            const lastSix = poolItemsAll.find(
              (r: any) => r.rarity >= 6 && !r.isFree,
            );
            if (lastSix) {
              displayPity = poolTotal - lastSix.poolTotalCount;
            } else {
              // No 6-stars, so pity never reset.
              const oldest = poolItemsAll[poolItemsAll.length - 1];
              const initial = Math.max(
                0,
                oldest.pitySixCount - oldest.poolTotalCount,
              );
              displayPity = initial + poolTotal;
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
            const paddedText = (
              tr?.("gacha_log_canvas_PaddedCount") ?? "已墊 <hardCount> 抽"
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
        const gId = resolveGroupIdForPool(p);
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
    const poolItemsAll = stats[
      type === "weapon" ? "weapon" : "char"
    ].history.filter((r: any) => r.poolId === group.pId);
    let initialPaddedCount = 0;
    if (poolItemsAll.length > 0) {
      const oldest = poolItemsAll[poolItemsAll.length - 1];
      initialPaddedCount = Math.max(
        0,
        oldest.pitySixCount - oldest.poolTotalCount,
      );
    } else {
      // Very rare: user views detailed mode of a pool with <10 pulls and no 4-stars.
      // We can fallback to currentPity - poolTotal if it's the newest.
      const categorySummary =
        stats[type === "weapon" ? "weapon" : "char"].summary[
          group.gId || "unknown"
        ];
      const poolTotal = categorySummary?.poolTotalMap?.[group.pId || ""] || 0;
      if ((group as any).isNewest)
        initialPaddedCount = Math.max(
          0,
          (categorySummary?.currentPity || 0) - poolTotal,
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
      (group.pId && poolBannerUrlMap.get(group.pId)) || poolApiData?.up6_image;
    ctx.fillStyle = "#111";
    ctx.font = "bold 52px NotoSansTCBold";
    ctx.fillText("I", centerPadding, currentY);
    const detailFallbackTitle = `I ${poolTitle}`;

    let titleRight = centerPadding;
    if (detailedBannerUrl) {
      try {
        const bannerImg = await fetchImage(
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

    // "總計"
    ctx.fillStyle = "#888";
    ctx.font = "28px NotoSans";
    ctx.fillText("總計", startX, headerMetaY);
    startX += ctx.measureText("總計").width + 8;

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

      // "加急"
      ctx.fillStyle = "#ffcc00";
      ctx.font = "28px NotoSans";
      ctx.fillText("加急", startX, headerMetaY);
      startX += ctx.measureText("加急").width + 8;
    }

    // "抽"
    ctx.fillStyle = "#888";
    ctx.font = "28px NotoSans";
    ctx.fillText("抽", startX, headerMetaY);

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
        ctx.fillText(
          (
            tr?.("gacha_log_canvas_PaddedCount") ?? "已墊 <hardCount> 抽"
          ).replace("<hardCount>", String(initialPaddedCount)),
          dCenterX + dRadius + 10,
          currentY + itemH / 2,
        );
        ctx.restore();
      }
    }
  }

  return canvas.toBuffer("image/webp", 90);
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
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (isEn) {
    // Background circle for "L" (LOSE)
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#1e3a8a"; // Deep blue
    ctx.fill();

    // White "L"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.25)}px NotoSansTCBold`;
    ctx.fillText("L", 0, -1);
  } else {
    // Background circle for "歪"
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ff0000";
    ctx.fill();

    // White "歪"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.1)}px NotoSansTCBold`;
    ctx.fillText("歪", 0, -2.5);
  }

  ctx.restore();
}
