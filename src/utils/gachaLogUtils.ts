import axios from "axios";
import { CustomDatabase } from "./Database";
import { mapLocaleToLang } from "./skportApi";
import moment from "moment";

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
export interface GachaLeaderboardEntry {
  uid: string;
  nickname: string;
  displayName?: string; // Discord display name
  gameNickname?: string;
  avatarUrl?: string; // Discord avatar
  lastUpdate: number;
  total: number;
  nonFreeTotal: number;
  freeTotal: number;
  accountIndex?: number; // 1-indexed account position
  poolNames?: Record<string, string>; // poolId -> poolName mapping
  stats: Record<
    string,
    {
      total: number;
      sixStarCount: number;
      fiveStarCount: number;
      probability: number;
    }
  >;
}

export interface GachaLogData {
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
  info: {
    uid: string;
    lang: string;
    serverId?: string;
    nickname?: string;
    avatarUrl?: string; // Store avatar URL in log data too
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

export function isPullFree(record: any): boolean {
  if (!record) return false;
  return (
    record.isFree === true ||
    record.is_free === 1 ||
    record.is_free === true ||
    record.is_free === "1" ||
    record.isFree === "true" ||
    record.isFree === 1
  );
}

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
  avatarUrl?: string,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
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
          item.isFree = isPullFree(item);
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
            item.isFree = isPullFree(item);
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
      nickname:
        gameNickname && gameNickname !== uid
          ? gameNickname
          : existingData.info.nickname && existingData.info.nickname !== uid
            ? existingData.info.nickname
            : undefined,
      avatarUrl: avatarUrl || existingData.info.avatarUrl,
      export_timestamp: Date.now(),
    },
  };

  await db.set(dbKey, updatedData);

  // Update leaderboard
  try {
    await updateLeaderboard(
      db,
      uid,
      updatedData,
      displayName,
      accountIndex,
      gameNickname,
    );
  } catch (e) {
    console.error(`[Leaderboard] Failed to update for ${uid}:`, e);
  }

  return {
    code: 0,
    message: "Success",
    totalChar: newCharList.length,
    totalWeapon: newWeaponList.length,
    data: updatedData,
  };
}

/**
 * Migrates data from a guest UID to a target UID (real account).
 * Merges records and updates the leaderboard.
 */
export async function migrateGachaLog(
  db: CustomDatabase,
  sourceUid: string,
  targetUid: string,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
) {
  const sourceKey = `GACHA_LOG_${sourceUid}`;
  const targetKey = `GACHA_LOG_${targetUid}`;

  const sourceData = await db.get<GachaLogData>(sourceKey);
  if (!sourceData) return null;

  const targetData = (await db.get<GachaLogData>(targetKey)) || {
    characterList: [],
    weaponList: [],
    info: { uid: targetUid, lang: sourceData.info.lang, export_timestamp: 0 },
  };

  // Merge logic (same as in fetchAndMergeGachaLog)
  const charMap = new Map<string, GachaRecord>();
  const weaponMap = new Map<string, GachaRecord>();

  targetData.characterList.forEach((r) => charMap.set(String(r.seqId), r));
  targetData.weaponList.forEach((r) => weaponMap.set(String(r.seqId), r));

  sourceData.characterList.forEach((r) => charMap.set(String(r.seqId), r));
  sourceData.weaponList.forEach((r) => weaponMap.set(String(r.seqId), r));

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
      ...targetData.info,
      nickname:
        targetData.info.nickname && targetData.info.nickname !== targetUid
          ? targetData.info.nickname
          : sourceData.info.nickname && sourceData.info.nickname !== targetUid
            ? sourceData.info.nickname
            : undefined,
      avatarUrl: targetData.info.avatarUrl || sourceData.info.avatarUrl,
      export_timestamp: Math.max(
        targetData.info.export_timestamp || 0,
        sourceData.info.export_timestamp || 0,
      ),
    },
  };

  await db.set(targetKey, updatedData);
  await db.delete(sourceKey);

  // Update leaderboard for target
  try {
    await updateLeaderboard(
      db,
      targetUid,
      updatedData,
      displayName,
      accountIndex,
      gameNickname || updatedData.info.nickname,
    );
  } catch (e) {
    console.error(`[Leaderboard] Failed to update for ${targetUid}:`, e);
  }

  // Remove source from leaderboard
  try {
    const lb =
      (await db.get<Record<string, GachaLeaderboardEntry>>(
        "GACHA_LEADERBOARD_ENTRIES",
      )) || {};
    if (lb[sourceUid]) {
      delete lb[sourceUid];
      await db.set("GACHA_LEADERBOARD_ENTRIES", lb);
    }
  } catch (e) {
    console.error(`[Leaderboard] Failed to remove guest log ${sourceUid}:`, e);
  }

  return updatedData;
}

export async function updateLeaderboard(
  db: CustomDatabase,
  uid: string,
  data: GachaLogData,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
) {
  const stats = await getGachaStats(db, data);
  const leaderboard =
    (await db.get<Record<string, GachaLeaderboardEntry>>(
      "GACHA_LEADERBOARD_ENTRIES",
    )) || {};

  const entry: GachaLeaderboardEntry = {
    uid,
    nickname:
      gameNickname && gameNickname !== uid
        ? gameNickname
        : data.info.nickname && data.info.nickname !== uid
          ? data.info.nickname
          : uid === "GUEST"
            ? "GUEST"
            : uid,
    displayName: displayName,
    gameNickname:
      gameNickname && gameNickname !== uid
        ? gameNickname
        : data.info.nickname && data.info.nickname !== uid
          ? data.info.nickname
          : undefined,
    avatarUrl: data.info.avatarUrl,
    lastUpdate: Date.now(),
    total: stats.char.total + stats.weapon.total,
    nonFreeTotal: stats.char.nonFreeTotal + stats.weapon.nonFreeTotal,
    freeTotal: stats.char.freeTotal + stats.weapon.freeTotal,
    accountIndex: accountIndex,
    stats: {},
    poolNames: {},
  };

  // Collect poolId -> poolName from all records
  const newPoolNames: Record<string, string> = {};
  for (const rec of [...data.characterList, ...data.weaponList]) {
    if (rec.poolId && rec.poolName) {
      newPoolNames[rec.poolId] = rec.poolName;
      if (entry.poolNames) entry.poolNames[rec.poolId] = rec.poolName;
    }
  }

  // Merge into global pool name dictionary (shared across all users)
  const globalPoolNames =
    (await db.get<Record<string, string>>("GACHA_POOL_NAMES")) || {};
  const mergedPoolNames = { ...globalPoolNames, ...newPoolNames };
  await db.set("GACHA_POOL_NAMES", mergedPoolNames);

  const processGroup = (gId: string, s: any) => {
    if (!s) return;
    const total = Number(s.nonFreeTotal || 0);
    const six = Number(s.sixStarCount || 0);
    const five = Number(s.fiveStarCount || 0);
    entry.stats[gId] = {
      total,
      sixStarCount: six,
      fiveStarCount: five,
      probability: total > 0 ? six / total : 0,
    };
  };

  for (const gId of Object.keys(stats.char.summary)) {
    processGroup(gId, stats.char.summary[gId]);
  }
  for (const gId of Object.keys(stats.weapon.summary)) {
    processGroup(gId, stats.weapon.summary[gId]);
  }

  // Add category shared stats to leaderboard entry
  processGroup("SpecialShared", stats.char.summary["SpecialShared"]);
  processGroup("StandardShared", stats.char.StandardShared);
  processGroup("WeaponShared", stats.weapon.WeaponShared);

  // Calculate TOTAL using the new explicit total metrics
  const totalNonFree = stats.char.nonFreeTotal + stats.weapon.nonFreeTotal;
  const totalFree = stats.char.freeTotal + stats.weapon.freeTotal;
  const totalAll = stats.char.total + stats.weapon.total;

  const totalSix =
    Object.values(stats.char.summary).reduce(
      (a, b) => a + Number((b as any).sixStarCount || 0),
      0,
    ) +
    Object.values(stats.weapon.summary).reduce(
      (a, b) => a + Number((b as any).sixStarCount || 0),
      0,
    );
  const totalFive =
    Object.values(stats.char.summary).reduce(
      (a, b) => a + Number((b as any).fiveStarCount || 0),
      0,
    ) +
    Object.values(stats.weapon.summary).reduce(
      (a, b) => a + Number((b as any).fiveStarCount || 0),
      0,
    );

  entry.stats["TOTAL"] = {
    total: Number(totalNonFree || 0),
    sixStarCount: Number(totalSix || 0),
    fiveStarCount: Number(totalFive || 0),
    probability: totalNonFree > 0 ? Number(totalSix || 0) / totalNonFree : 0,
  };

  // Also compute per-poolId stats from raw records (for sub-pool leaderboard)
  // This handles cases where getPityGroupId merges pools (e.g. SpecialShared)
  const buildPerPoolStats = (list: GachaRecord[]) => {
    const grouped: Record<string, GachaRecord[]> = {};
    for (const rec of list) {
      if (!rec.poolId) continue;
      if (!grouped[rec.poolId]) grouped[rec.poolId] = [];
      grouped[rec.poolId].push(rec);
    }
    for (const [pid, recs] of Object.entries(grouped)) {
      const nonFree = recs.filter((r) => !r.isFree);
      const six = nonFree.filter((r) => r.rarity >= 6).length;
      const five = nonFree.filter((r) => r.rarity >= 5 && r.rarity < 6).length;
      const total = nonFree.length;
      if (!entry.stats[pid] || entry.stats[pid].total === 0) {
        entry.stats[pid] = {
          total,
          sixStarCount: six,
          fiveStarCount: five,
          probability: total > 0 ? six / total : 0,
        };
      }
    }
  };
  buildPerPoolStats(data.characterList);
  buildPerPoolStats(data.weaponList);

  if (!uid.startsWith("EF_GUEST_") && uid !== "EF_undefined") {
    leaderboard[uid] = entry;
  } else if (leaderboard[uid]) {
    // If it was already in the leaderboard somehow, remove it
    delete leaderboard[uid];
  }

  await db.set("GACHA_LEADERBOARD_ENTRIES", leaderboard);
}

/**
 * Clear gacha log for a specific UID, optionally within a time range.
 * @param startTime ISO string or YYYY-MM-DD
 * @param endTime ISO string or YYYY-MM-DD
 */
export async function clearGachaLog(
  db: CustomDatabase,
  uid: string,
  startTime?: string,
  endTime?: string,
) {
  const dbKey = `GACHA_LOG_${uid}`;
  const data = await db.get<GachaLogData>(dbKey);

  if (!data) return false;

  const start = startTime ? moment(startTime).valueOf() : 0;
  const end = endTime ? moment(endTime).valueOf() : Infinity;

  const filterFn = (r: GachaRecord) => {
    const ts = moment(r.gachaTs).valueOf();
    return ts < start || ts > end;
  };

  data.characterList = data.characterList.filter(filterFn);
  data.weaponList = data.weaponList.filter(filterFn);

  if (data.characterList.length === 0 && data.weaponList.length === 0) {
    await db.delete(dbKey);
    // Remove from leaderboard too
    const leaderboard =
      (await db.get<Record<string, GachaLeaderboardEntry>>(
        "GACHA_LEADERBOARD_ENTRIES",
      )) || {};
    delete leaderboard[uid];
    await db.set("GACHA_LEADERBOARD_ENTRIES", leaderboard);
  } else {
    await db.set(dbKey, data);
    await updateLeaderboard(db, uid, data);
  }

  return true;
}

/**
 * Retrospectively sync all existing gacha logs in the database to the leaderboard
 */
export async function syncExistingLogsToLeaderboard(db: CustomDatabase) {
  const allLogs = await db.findByPrefix<GachaLogData>("GACHA_LOG_");
  console.log(
    `[Leaderboard Sync] Found ${allLogs.length} existing logs to sync.`,
  );

  for (const log of allLogs) {
    const uid = log.id.replace("GACHA_LOG_", "");
    try {
      await updateLeaderboard(db, uid, log.value);
    } catch (e) {
      console.error(`[Leaderboard Sync] Failed to sync ${uid}:`, e);
    }
  }
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
      let currentFreeBlock: any = null;

      for (const record of reversed) {
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

          let isOffRate = false;
          let isFeatured = false;
          const rarityNum = Number(record.rarity || 0);

          if (
            rarityNum >= 6 &&
            (record.poolType?.includes("Special") ||
              record.poolType?.includes("WeaponPool") ||
              record.poolName?.includes("特選"))
          ) {
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
                // Priority 3: Name match in pool title fallback
                if (
                  record.poolName &&
                  (record.poolName.includes(name || "") ||
                    (record.charName &&
                      record.poolName.includes(record.charName)))
                ) {
                  isFeatured = true;
                } else if (STANDARD_SIX_STARS.includes(recordCid)) {
                  // Priority 4: Standard List Fallback
                  isOffRate = true;
                } else {
                  isFeatured = true;
                }
              }

              // Final Fallback for featured status in Limited Pools
              if (
                !isFeatured &&
                !isOffRate &&
                rarityNum >= 6 &&
                (record.poolType?.includes("Special") ||
                  record.poolType?.includes("WeaponPool") ||
                  record.poolName?.includes("特選"))
              ) {
                const recordCid = String(record.charId || "").replace(
                  "icon_",
                  "",
                );
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
            poolTotalCount: poolTotalCounters.get(pId) || 0, // Use non-free pool total
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
              poolSixStarPullCounters.set(
                pId,
                (poolSixStarPullCounters.get(pId) || 0) + 1,
              );
              if (isFeatured) {
                featuredPity = 0;
                poolFeaturedSixCounters.set(
                  pId,
                  (poolFeaturedSixCounters.get(pId) || 0) + 1,
                );
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

  const charStats = calculateDetailedHistory(data.characterList, "char");
  const weaponStats = calculateDetailedHistory(data.weaponList, "weapon");

  return {
    uid: data.info.uid,
    char: charStats,
    weapon: weaponStats,
  };
}
