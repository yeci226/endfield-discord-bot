import { CustomDatabase } from "../../utils/Database";
import { getGachaPityGroupId } from "../../utils/gachaPoolUtils";
import moment from "moment";
import { getPoolMetadata } from "./gachaApi";
import { GachaLogData, GachaRecord, isGachaPull, isPullFree } from "./gachaTypes";

/**
 * Version of the statistics algorithm. Cached stats (gachaStatsCache.ts) carry
 * the version they were computed with; bump this whenever getGachaStats can
 * return different numbers for the same log.
 */
export const ENGINE_VERSION = 2;

const STANDARD_SIX_STARS = [
  "chr_0009_azrila",
  "chr_0015_lifeng",
  "chr_0025_ardelia",
  "chr_0026_lastrite",
  "chr_0029_pograni",
];

export type FeaturedStatus = "featured" | "offRate" | "unknown";

function sumMapValues(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/** Pools where a 6-star is either the rate-up item or an off-rate one. */
export function isLimitedRateUpPool(record: {
  poolType?: string;
  poolName?: string;
}): boolean {
  return !!(
    record.poolType?.includes("Special") ||
    record.poolType?.includes("Rerun") ||
    record.poolType?.includes("WeaponPool") ||
    record.poolName?.includes("特選")
  );
}

/**
 * Was this 6-star the pool's rate-up item? Resolution order:
 *   1. pool metadata (up6 ids, then up6 names),
 *   2. the item's name in the pool title,
 *   3. the standard (permanent) six-star list: off-rate,
 *   4. otherwise "unknown" - never assumed featured.
 * Pure: takes plain data only.
 */
export function classifyFeaturedSixStar(
  record: GachaRecord,
  name: string | undefined,
  pMeta: any,
  standardSixStars: ReadonlySet<string>,
): FeaturedStatus {
  const recordCid = String(record.charId || record.weaponId || "").replace(
    "icon_",
    "",
  );

  // Only the CURRENT up6 target counts (rotate_list is ignored on purpose).
  const upCids: string[] = [];
  if (pMeta?.all) {
    const upName = pMeta.up6_name;
    const upItemName = pMeta.up6_item_name;
    if (upName || upItemName) {
      for (const a of pMeta.all) {
        if (
          a.rarity >= 6 &&
          (a.name === upName ||
            a.name === upItemName ||
            (upItemName && upItemName.includes(a.name)))
        ) {
          upCids.push(String(a.id).replace("icon_", ""));
        }
      }
    }
  }
  if (upCids.length > 0) {
    return upCids.includes(recordCid) ? "featured" : "offRate";
  }

  if (pMeta?.up6_item_name || pMeta?.up6_name) {
    const upName = pMeta.up6_item_name || pMeta.up6_name;
    return name === upName ||
      record.charName === upName ||
      record.weaponName === upName
      ? "featured"
      : "offRate";
  }

  const poolName = record.poolName || "";
  if (
    poolName &&
    ((name && poolName.includes(name)) ||
      (record.charName && poolName.includes(record.charName)))
  ) {
    return "featured";
  }
  if (recordCid && standardSixStars.has(recordCid)) return "offRate";
  return "unknown";
}

export async function getGachaStats(db: CustomDatabase, data: GachaLogData) {
  // Filter on read so previously saved gift events no longer inflate stats.
  // Keep the raw log intact for API pagination and import gap detection.
  const characterList = data.characterList.filter(isGachaPull);
  const weaponList = data.weaponList.filter(isGachaPull);
  const uniquePoolIds = new Set<string>();
  characterList.forEach((r) => r.poolId && uniquePoolIds.add(r.poolId));
  weaponList.forEach((r) => r.poolId && uniquePoolIds.add(r.poolId));

  const poolMetaMap: Record<string, any> = {};
  for (const pid of uniquePoolIds) {
    const pm = await getPoolMetadata(
      db,
      pid,
      data.info.lang,
      data.info.serverId,
    );
    if (pm) poolMetaMap[pid] = pm;
  }

  // Build a dynamic set of known standard characters from the user's own standard/beginner
  // pool history. This is more reliable than a hardcoded list because it automatically
  // captures all permanent characters the game has ever added, without manual maintenance.
  // When a standard character appears off-rate in a limited/weapon pool and their pool
  // metadata is missing, this set ensures they are still correctly identified as off-rate.
  const dynamicStandardSixStars = new Set<string>(STANDARD_SIX_STARS);
  for (const rec of characterList) {
    if (
      (rec.poolType?.includes("Standard") ||
        rec.poolType?.includes("Beginner")) &&
      rec.rarity >= 6 &&
      !isPullFree(rec)
    ) {
      const cid = String(rec.charId || "").replace("icon_", "");
      if (cid) dynamicStandardSixStars.add(cid);
    }
  }

  const calculateDetailedHistory = (
    list: GachaRecord[],
    type: "char" | "weapon",
    pityResetSeqId?: string,
  ) => {
    const pityGroups = new Map<string, GachaRecord[]>();
    list.forEach((r) => {
      const gId = getGachaPityGroupId(r);
      if (!pityGroups.has(gId)) pityGroups.set(gId, []);
      pityGroups.get(gId)!.push(r);
    });

    const allHistory: any[] = [];
    /**
     * summary[gId] = {
     *   currentPity: number (80/40),
     *   featuredPity: number (120/80),
     *   total: number
     * }
     */
    const summary: Record<
      string,
      {
        currentPity: number;
        featuredPity: number;
        total: number;
        nonFreeTotal: number;
        freeTotal: number;
        sixStarCount: number;
        fiveStarCount: number;
        sixStarPullCount: number; // Only from non-free pulls
        fiveStarPullCount: number; // Only from non-free pulls
      }
    > = {};
    const poolList = new Map<string, string>(); // poolId -> poolName

    for (const [gId, records] of pityGroups.entries()) {
      const reversed = [...records].reverse();
      let pitySix = 0; // Soft Pity: Resets on ANY 6★
      let pityLabel = 0; // Item display: Resets on ANY 5/6★
      let featuredPity = 0; // Hard Guarantee: Resets only on Rate-up 6★
      const featuredCounters = new Map<string, number>(); // poolId -> count
      const poolTotalCounters = new Map<string, number>(); // poolId -> non-free total
      const hasFeaturedMap = new Map<string, boolean>(); // poolId -> has obtained featured
      let totalCounter = 0;
      let nonFreeTotalCounter = 0;
      let freeTotalCounter = 0;
      const poolFreeTotalCounters = new Map<string, number>(); // poolId -> free total count
      const poolSixStarPullCounters = new Map<string, number>(); // poolId -> non-free 6* count
      const poolFeaturedSixCounters = new Map<string, number>(); // poolId -> non-free featured 6* count
      const poolUnknownFeaturedCounters = new Map<string, number>(); // poolId -> 6* whose featured status is unknown
      let currentFreeBlock: any = null;
      let pityResetApplied = false;

      for (const record of reversed) {
        // If a data gap was detected on last import, reset all pity-state counters
        // once we reach the first record that falls inside the gap-free window.
        if (
          pityResetSeqId &&
          !pityResetApplied &&
          Number(record.seqId) >= Number(pityResetSeqId)
        ) {
          pitySix = 0;
          pityLabel = 0;
          featuredPity = 0;
          featuredCounters.clear();
          hasFeaturedMap.clear();
          pityResetApplied = true;
        }

        if (record.poolId && record.poolName) {
          poolList.set(record.poolId, record.poolName);
        }

        const pId = record.poolId || "unknown";
        // Endfield milestone gifts (isFree) are separate and don't count towards pity counters
        const isActuallyFree = isPullFree(record);

        if (isActuallyFree) {
          if (!currentFreeBlock) {
            currentFreeBlock = {
              isExpeditedBlock: true,
              count: 0,
              poolId: pId,
              seqId: record.seqId,
              gachaTs: record.gachaTs,
              rarity: 0,
            };
          }
          currentFreeBlock.count++;
        } else {
          if (currentFreeBlock) {
            allHistory.push(currentFreeBlock);
            currentFreeBlock = null;
          }
        }

        totalCounter++; // Global Counter for this group (True Total)
        if (!isActuallyFree) {
          pitySix++;
          pityLabel++;
          featuredPity++;
          const curFeaturedCount = (featuredCounters.get(pId) || 0) + 1;
          featuredCounters.set(pId, curFeaturedCount);

          const curPoolTotal = (poolTotalCounters.get(pId) || 0) + 1;
          poolTotalCounters.set(pId, curPoolTotal);
          nonFreeTotalCounter++;
        } else {
          const curPoolFree = (poolFreeTotalCounters.get(pId) || 0) + 1;
          poolFreeTotalCounters.set(pId, curPoolFree);
          freeTotalCounter++;
        }

        if (record.rarity >= 4) {
          let name = record.charName || record.weaponName;
          const pMeta = poolMetaMap[pId];

          if (pMeta?.all) {
            const found = pMeta.all.find(
              (a: any) => a.id === record.charId || a.id === record.weaponId,
            );
            if (found) name = name || found.name;
          }

          const rarityNum = Number(record.rarity || 0);
          const featuredStatus: FeaturedStatus | null =
            rarityNum >= 6 && isLimitedRateUpPool(record)
              ? classifyFeaturedSixStar(
                  record,
                  name,
                  pMeta,
                  dynamicStandardSixStars,
                )
              : null;
          const isFeatured = featuredStatus === "featured";
          const isOffRate = featuredStatus === "offRate";
          const isUnknownFeatured = featuredStatus === "unknown";

          allHistory.push({
            ...record,
            name,
            pityCount: pityLabel,
            featuredPityCount: featuredPity, // This represents distance from last featured
            totalCount: totalCounter,
            poolTotalCount: poolTotalCounters.get(pId) || 0, // Use non-free pool total
            pitySixCount: pitySix,
            pityGroupId: gId,
            isFeatured,
            isOffRate,
            ...(isUnknownFeatured ? { isUnknownFeatured: true } : {}),
            isFree: isActuallyFree,
          });

          if (rarityNum >= 6 && isUnknownFeatured) {
            // Unknown status: counted in neither numerator nor denominator of
            // the win rate, but reported so the card can say so later.
            poolUnknownFeaturedCounters.set(
              pId,
              (poolUnknownFeaturedCounters.get(pId) || 0) + 1,
            );
          } else if (rarityNum >= 6) {
            // Count all 6-stars (including free expedited) for win-rate tracking
            poolSixStarPullCounters.set(
              pId,
              (poolSixStarPullCounters.get(pId) || 0) + 1,
            );
            if (isFeatured) {
              poolFeaturedSixCounters.set(
                pId,
                (poolFeaturedSixCounters.get(pId) || 0) + 1,
              );
            }
          }

          if (!isActuallyFree) {
            if (rarityNum >= 6) {
              pitySix = 0;
              pityLabel = 0;
              // Pity bookkeeping keeps the old assumption for unknown 6-stars
              // (they reset the hard-guarantee counter); only the win rate
              // stopped counting them.
              if (isFeatured || isUnknownFeatured) {
                featuredPity = 0;
                // Non-shared 120: Reset pool-specific featured pity
                featuredCounters.set(pId, 0);
                hasFeaturedMap.set(pId, true);
              }
            } else if (rarityNum === 5) {
              pityLabel = 0;
            }
          }
        }
      }

      if (currentFreeBlock) {
        allHistory.push(currentFreeBlock);
      }

      summary[gId] = {
        currentPity: pitySix,
        featuredPity: featuredPity,
        total: totalCounter, // True Total (spent + free)
        nonFreeTotal: nonFreeTotalCounter, // Just spent
        freeTotal: freeTotalCounter, // Just expedited
        sixStarCount: records.filter((r) => r.rarity >= 6).length,
        fiveStarCount: records.filter((r) => r.rarity >= 5 && r.rarity < 6)
          .length,
        sixStarPullCount: records.filter((r) => r.rarity >= 6 && !isPullFree(r))
          .length,
        fiveStarPullCount: records.filter(
          (r) => r.rarity >= 5 && r.rarity < 6 && !isPullFree(r),
        ).length,
        featuredPityMap: Object.fromEntries(featuredCounters),
        poolTotalMap: Object.fromEntries(poolTotalCounters),
        poolFreeTotalMap: Object.fromEntries(poolFreeTotalCounters),
        poolSixStarPullMap: Object.fromEntries(poolSixStarPullCounters),
        poolFeaturedSixMap: Object.fromEntries(poolFeaturedSixCounters),
        poolUnknownFeaturedMap: Object.fromEntries(poolUnknownFeaturedCounters),
        unknownFeaturedCount: sumMapValues(poolUnknownFeaturedCounters),
        hasFeaturedMap: Object.fromEntries(hasFeaturedMap),
      } as any;
    }

    allHistory.sort((a, b) => Number(b.seqId) - Number(a.seqId));

    // Sort pools: Limited (Newest first) > Standard (2nd last) > Beginner (Last)
    const sortedPools = Array.from(poolList.entries())
      .map(([id, name]) => {
        const sample = list.find((r) => r.poolId === id);
        const poolRecords = list.filter((r) => r.poolId === id);
        let startTs = "";
        let endTs = "";
        if (poolRecords.length > 0) {
          const sortedRecs = [...poolRecords].sort((a, b) => {
            const tsA =
              typeof a.gachaTs === "string" && /^\d+$/.test(a.gachaTs)
                ? Number(a.gachaTs)
                : moment(a.gachaTs).valueOf();
            const tsB =
              typeof b.gachaTs === "string" && /^\d+$/.test(b.gachaTs)
                ? Number(b.gachaTs)
                : moment(b.gachaTs).valueOf();
            return tsA - tsB;
          });
          startTs = sortedRecs[0].gachaTs;
          endTs = sortedRecs[sortedRecs.length - 1].gachaTs;
        }

        return {
          id,
          name,
          type: sample?.poolType || "",
          ts: sample?.gachaTs || "",
          startTs,
          endTs,
          bannerUrl:
            poolMetaMap[id]?.up6_image ||
            poolMetaMap[id]?.up5_image ||
            poolMetaMap[id]?.banner_image ||
            "",
        };
      })
      .sort((a, b) => {
        const isLimitedA =
          a.type.includes("Special") || a.type.includes("Joint");
        const isLimitedB =
          b.type.includes("Special") || b.type.includes("Joint");
        const isBeginnerA = a.type.includes("Beginner");
        const isBeginnerB = b.type.includes("Beginner");
        const isStandardA = a.type.includes("Standard");
        const isStandardB = b.type.includes("Standard");

        if (isLimitedA && !isLimitedB) return -1;
        if (!isLimitedA && isLimitedB) return 1;
        if (isLimitedA && isLimitedB) return b.ts.localeCompare(a.ts);

        if (isStandardA && isBeginnerB) return -1;
        if (isBeginnerA && isStandardB) return 1;

        return b.ts.localeCompare(a.ts);
      });

    const globalTotal = Object.values(summary).reduce(
      (sum, s) => sum + (s.total || 0),
      0,
    );
    const globalNonFree = Object.values(summary).reduce(
      (sum, s) => sum + (s.nonFreeTotal || 0),
      0,
    );
    const globalFree = Object.values(summary).reduce(
      (sum, s) => sum + (s.freeTotal || 0),
      0,
    );

    return {
      history: allHistory,
      summary,
      total: globalTotal,
      nonFreeTotal: globalNonFree,
      freeTotal: globalFree,
      // 6-stars in limited/weapon pools whose featured status could not be
      // resolved (not in any win-rate number).
      unknownFeaturedCount: Object.values(summary).reduce(
        (sum, s) => sum + ((s as any).unknownFeaturedCount || 0),
        0,
      ),
      pools: sortedPools.map((p) => {
        // Find if this specific pool had free pulls
        let freeCount = 0;
        let poolTotal = 0;
        for (const s of Object.values(summary)) {
          const sObj = s as any;
          if (sObj.poolFreeTotalMap && sObj.poolFreeTotalMap[p.id]) {
            freeCount += sObj.poolFreeTotalMap[p.id];
          }
          if (sObj.poolTotalMap && sObj.poolTotalMap[p.id]) {
            poolTotal += sObj.poolTotalMap[p.id];
          }
        }

        return {
          id: p.id,
          name: p.name,
          type: p.type,
          startTs: p.startTs,
          endTs: p.endTs,
          total: poolTotal, // Current non-free total
          freeCount,
          bannerUrl: p.bannerUrl,
          sixStarPullCount:
            Object.values(summary).reduce(
              (sum, s) => sum + ((s as any).poolSixStarPullMap?.[p.id] || 0),
              0,
            ) || 0,
          featuredSixCount:
            Object.values(summary).reduce(
              (sum, s) => sum + ((s as any).poolFeaturedSixMap?.[p.id] || 0),
              0,
            ) || 0,
          unknownFeaturedCount:
            Object.values(summary).reduce(
              (sum, s) =>
                sum + ((s as any).poolUnknownFeaturedMap?.[p.id] || 0),
              0,
            ) || 0,
        };
      }),
      StandardShared: {
        total: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.total || 0), 0),
        nonFreeTotal: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.nonFreeTotal || 0), 0),
        sixStarCount: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.sixStarCount || 0), 0),
        fiveStarCount: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.fiveStarCount || 0), 0),
        sixStarPullCount: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.sixStarPullCount || 0), 0),
        fiveStarPullCount: Object.values(summary)
          .filter((_, i) => Object.keys(summary)[i].startsWith("Standard_"))
          .reduce((sum, s) => sum + (s.fiveStarPullCount || 0), 0),
      },
      WeaponShared: {
        total:
          type === "weapon"
            ? Object.values(summary).reduce((sum, s) => sum + (s.total || 0), 0)
            : 0,
        nonFreeTotal:
          type === "weapon"
            ? Object.values(summary).reduce(
                (sum, s) => sum + (s.nonFreeTotal || 0),
                0,
              )
            : 0,
        sixStarCount:
          type === "weapon"
            ? Object.values(summary).reduce(
                (sum, s) => sum + (s.sixStarCount || 0),
                0,
              )
            : 0,
        fiveStarCount:
          type === "weapon"
            ? Object.values(summary).reduce(
                (sum, s) => sum + (s.fiveStarCount || 0),
                0,
              )
            : 0,
        sixStarPullCount:
          type === "weapon"
            ? Object.values(summary).reduce(
                (sum, s) => sum + (s.sixStarPullCount || 0),
                0,
              )
            : 0,
        fiveStarPullCount:
          type === "weapon"
            ? Object.values(summary).reduce(
                (sum, s) => sum + (s.fiveStarPullCount || 0),
                0,
              )
            : 0,
      },
    };
  };

  const charStats = calculateDetailedHistory(
    characterList,
    "char",
    data.info.charPityResetSeqId,
  );
  const weaponStats = calculateDetailedHistory(
    weaponList,
    "weapon",
    data.info.weaponPityResetSeqId,
  );

  return {
    uid: data.info.uid,
    char: charStats,
    weapon: weaponStats,
  };
}
