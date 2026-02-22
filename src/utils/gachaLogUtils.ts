import axios from "axios";
import { CustomDatabase } from "./Database";
import { mapLocaleToLang } from "./skportApi";

export interface GachaRecord {
  seqId: string;
  charId?: string;
  charName?: string;
  weaponId?: string;
  weaponName?: string;
  rarity: number;
  gachaTs: string;
  poolId: string;
  poolName: string;
  poolType: string;
  isFree: boolean;
  [key: string]: any;
}

export interface GachaLogData {
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
  info: {
    uid: string;
    lang: string;
    serverId?: string;
    nickname?: string;
    export_timestamp: number;
  };
}

const POOL_TYPES = [
  "E_CharacterGachaPoolType_Standard",
  "E_CharacterGachaPoolType_Special",
  "E_CharacterGachaPoolType_Beginner",
];

const STANDARD_SIX_STARS = [
  "chr_0009_azrila",
  "chr_0015_lifeng",
  "chr_0025_ardelia",
  "chr_0026_lastrite",
  "chr_0029_pograni",
];

export async function getPoolMetadata(
  db: CustomDatabase,
  poolId: string,
  lang?: string,
  serverId?: string,
) {
  if (!poolId || poolId === "unknown") return null;
  const cacheKey = `GACHA_POOL_METADATA_${poolId}`;
  const cached = await db.get<{ data: any; lastFetch: number }>(cacheKey);

  if (cached) {
    return cached.data;
  }

  const resolvedLang = lang || "zh-tw";
  const resolvedServerId = serverId || "2";

  try {
    const res = await axios.get(
      `https://ef-webview.gryphline.com/api/content?lang=${resolvedLang}&pool_id=${poolId}&server_id=${resolvedServerId}`,
    );
    if (res.data?.code === 0 && res.data?.data?.pool) {
      const poolData = res.data.data.pool;
      await db.set(cacheKey, {
        data: poolData,
        lastFetch: Date.now(),
      });
      return poolData;
    }
  } catch (error) {
    console.error(`Failed to fetch pool metadata for ${poolId}:`, error);
  }

  return null;
}

/**
 * Fetch gacha records from Gryphline API and merge with existing local data
 */
export async function fetchAndMergeGachaLog(
  db: CustomDatabase,
  urlStr: string,
  onProgress?: (message: string) => void,
  targetUid?: string,
  locale?: string,
) {
  const url = new URL(urlStr);
  const token =
    url.searchParams.get("token") || url.searchParams.get("u8_token");
  const lang = locale
    ? mapLocaleToLang(locale)
    : url.searchParams.get("lang") || "en-us";
  const serverId =
    url.searchParams.get("server_id") || url.searchParams.get("server");
  const apiDomain = `${url.protocol}//${url.host}`;

  if (!token || !serverId) {
    throw new Error("Invalid URL: Missing token or server_id");
  }

  const host = url.host;
  let uid = targetUid || `EF_${serverId}`;
  if (!targetUid && host.includes("hypergryph")) {
    uid = `EF_CN_${serverId}`;
  }

  const dbKey = `GACHA_LOG_${uid}`;
  const existingData = (await db.get<GachaLogData>(dbKey)) || {
    characterList: [],
    weaponList: [],
    info: { uid, lang, export_timestamp: 0 },
  };

  const existingSeqIds = new Set([
    ...existingData.characterList.map((r) => String(r.seqId)),
    ...existingData.weaponList.map((r) => String(r.seqId)),
  ]);

  const characterList: GachaRecord[] = [];
  const weaponList: GachaRecord[] = [];

  // 1. Fetch character records
  for (const poolType of POOL_TYPES) {
    let hasMore = true;
    let lastSeqId: string | undefined = undefined;
    let page = 1;

    while (hasMore) {
      if (onProgress)
        onProgress(`Fetching character records (${poolType}, page ${page})...`);

      const res = await axios.get(`${apiDomain}/api/record/char`, {
        params: {
          token,
          lang,
          server_id: serverId,
          pool_type: poolType,
          seq_id: lastSeqId,
        },
      });

      const data = res.data;
      if (data.code !== 0) {
        throw new Error(data.message || "API Error");
      }

      const list = data.data.list as GachaRecord[];
      if (list && list.length > 0) {
        for (const item of list) {
          item.poolType = poolType;
          characterList.push(item);
        }
        lastSeqId = list[list.length - 1].seqId;
      }
      hasMore = data.data.hasMore;
      page++;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // 2. Fetch weapon pools and records
  if (onProgress) onProgress("Fetching weapon pools...");
  const wpRes = await axios.get(`${apiDomain}/api/record/weapon/pool`, {
    params: { lang, token, server_id: serverId },
  });

  if (wpRes.data.code === 0) {
    const weaponPools = wpRes.data.data;
    for (const pool of weaponPools) {
      const poolId = pool.poolId;
      const poolName = pool.poolName;
      let hasMore = true;
      let lastSeqId: string | undefined = undefined;
      let page = 1;

      while (hasMore) {
        if (onProgress)
          onProgress(`Fetching weapon records (${poolName}, page ${page})...`);

        const res = await axios.get(`${apiDomain}/api/record/weapon`, {
          params: {
            token,
            lang,
            server_id: serverId,
            pool_id: poolId,
            seq_id: lastSeqId,
          },
        });

        const data = res.data;
        if (data.code !== 0) break;

        const list = data.data.list as GachaRecord[];
        if (list && list.length > 0) {
          for (const item of list) {
            item.poolType = "WeaponPool";
            weaponList.push(item);
          }
          lastSeqId = list[list.length - 1].seqId;
        }
        hasMore = data.data.hasMore;
        page++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  // 3. Merge and persist
  // We use a Map keyed by seqId to merge and update records
  const charMap = new Map<string, GachaRecord>();
  const weaponMap = new Map<string, GachaRecord>();

  // Load existing records into maps first
  existingData.characterList.forEach((r) => charMap.set(String(r.seqId), r));
  existingData.weaponList.forEach((r) => weaponMap.set(String(r.seqId), r));

  // Overwrite with newly fetched (and potentially localized) records
  characterList.forEach((r) => charMap.set(String(r.seqId), r));
  weaponList.forEach((r) => weaponMap.set(String(r.seqId), r));

  const newCharList = Array.from(charMap.values()).sort(
    (a, b) => Number(b.seqId) - Number(a.seqId),
  );
  const newWeaponList = Array.from(weaponMap.values()).sort(
    (a, b) => Number(b.seqId) - Number(a.seqId),
  );

  const updatedData: GachaLogData = {
    characterList: newCharList,
    weaponList: newWeaponList,
    info: {
      uid,
      lang,
      serverId,
      export_timestamp: Date.now(),
    },
  };

  await db.set(dbKey, updatedData);

  return {
    code: 0,
    message: "Success",
    totalChar: newCharList.length,
    totalWeapon: newWeaponList.length,
    data: updatedData,
  };
}

export async function getGachaStats(db: CustomDatabase, data: GachaLogData) {
  const uniquePoolIds = new Set<string>();
  data.characterList.forEach((r) => r.poolId && uniquePoolIds.add(r.poolId));
  data.weaponList.forEach((r) => r.poolId && uniquePoolIds.add(r.poolId));

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

  const getPityGroupId = (record: GachaRecord) => {
    const type = record.poolType || "";
    const pId = record.poolId || "";
    const pName = record.poolName || "";

    if (type.includes("Special") || pId.startsWith("c_special"))
      return "SpecialShared";
    if (type.includes("Beginner") || pId.startsWith("c_beginner"))
      return "Beginner";
    if (
      type.includes("Standard") ||
      pId.startsWith("c_standard") ||
      pName.includes("常駐")
    )
      return `Standard_${pId}`;

    if (pName.includes("特選") || pName.includes("限定"))
      return "SpecialShared";
    if (pName.includes("新手")) return "Beginner";

    if (record.poolType === "WeaponPool" || pId.startsWith("w_")) return pId;

    return pId || "Unknown";
  };

  const calculateDetailedHistory = (
    list: GachaRecord[],
    type: "char" | "weapon",
  ) => {
    const pityGroups = new Map<string, GachaRecord[]>();
    list.forEach((r) => {
      const gId = getPityGroupId(r);
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
      { currentPity: number; featuredPity: number; total: number }
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

      for (const record of reversed) {
        if (record.poolId && record.poolName) {
          poolList.set(record.poolId, record.poolName);
        }

        const pId = record.poolId || "unknown";
        // Endfield milestone gifts (isFree) are separate and don't count towards pity counters
        const isActuallyFree = record.isFree === true;

        if (!isActuallyFree) {
          pitySix++;
          pityLabel++;
          featuredPity++;
          const curFeaturedCount = (featuredCounters.get(pId) || 0) + 1;
          featuredCounters.set(pId, curFeaturedCount);
        }

        totalCounter++;
        const curPoolTotal = (poolTotalCounters.get(pId) || 0) + 1;
        poolTotalCounters.set(pId, curPoolTotal);

        if (record.rarity >= 4) {
          let name = record.charName || record.weaponName;
          const pMeta = poolMetaMap[pId];

          if (pMeta?.all) {
            const found = pMeta.all.find(
              (a: any) => a.id === record.charId || a.id === record.weaponId,
            );
            if (found) name = name || found.name;
          }

          let isOffRate = false;
          let isFeatured = false;
          const rarityNum = Number(record.rarity || 0);

          if (rarityNum >= 6 && record.poolType?.includes("Special")) {
            // Priority 1: Match by ID
            const recordCid = String(record.charId || "").replace("icon_", "");

            // Try to resolve UP character ID from pool metadata names
            let upCids: string[] = [];
            if (pMeta?.all && (pMeta.up6_name || pMeta.up6_item_name)) {
              const upName = pMeta.up6_name;
              const upItemName = pMeta.up6_item_name;

              for (const a of pMeta.all) {
                if (
                  a.rarity >= 6 &&
                  (a.name === upName ||
                    a.name === upItemName ||
                    (upItemName && upItemName.includes(a.name)))
                ) {
                  upCids.push(a.id.replace("icon_", ""));
                }
              }
            }

            if (upCids.length > 0) {
              if (upCids.includes(recordCid)) {
                isFeatured = true;
              } else {
                isOffRate = true;
              }
            } else {
              // Priority 2: Traditional Name Match
              if (pMeta?.up6_item_name || pMeta?.up6_name) {
                const upName = pMeta.up6_item_name || pMeta.up6_name;
                // Compare with current localized name or standard name
                if (
                  name === upName ||
                  record.charName === upName ||
                  record.weaponName === upName
                ) {
                  isFeatured = true;
                } else {
                  isOffRate = true;
                }
              } else {
                // Priority 3: Standard List Fallback
                if (STANDARD_SIX_STARS.includes(recordCid)) {
                  isOffRate = true;
                } else {
                  isFeatured = true;
                }
              }
            }
          }

          allHistory.push({
            ...record,
            name,
            pityCount: pityLabel,
            featuredPityCount: featuredPity, // This represents distance from last featured
            totalCount: totalCounter,
            poolTotalCount: curPoolTotal, // Use the specific pool total
            pitySixCount: pitySix,
            pityGroupId: gId,
            isFeatured,
            isOffRate,
            isFree: isActuallyFree,
          });

          if (!isActuallyFree) {
            if (rarityNum >= 6) {
              pitySix = 0;
              pityLabel = 0;
              if (isFeatured) {
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

      summary[gId] = {
        currentPity: pitySix,
        featuredPity: featuredPity,
        total: totalCounter,
        featuredPityMap: Object.fromEntries(featuredCounters),
        poolTotalMap: Object.fromEntries(poolTotalCounters),
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
          // list is sorted oldest to newest? The user mentioned allHistory is sorted newest first later.
          // Let's sort just to be safe.
          const sortedRecs = [...poolRecords].sort((a, b) =>
            a.gachaTs.localeCompare(b.gachaTs),
          );
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
        };
      })
      .sort((a, b) => {
        const isLimitedA = a.type.includes("Special");
        const isLimitedB = b.type.includes("Special");
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

    const totalNonFree = Object.values(summary).reduce(
      (sum, s) => sum + s.total,
      0,
    );

    return {
      history: allHistory,
      summary,
      total: totalNonFree,
      pools: sortedPools.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        startTs: p.startTs,
        endTs: p.endTs,
      })),
    };
  };

  const charStats = calculateDetailedHistory(data.characterList, "char");
  const weaponStats = calculateDetailedHistory(data.weaponList, "weapon");

  return {
    uid: data.info.uid,
    char: charStats,
    weapon: weaponStats,
  };
}
