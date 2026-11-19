import moment from "moment";
import { CustomDatabase } from "../../utils/Database";
import axios from "axios";
import { mapLocaleToLang, refreshAccountToken } from "../../utils/skportApi";
import { getEndfieldU8Token, fetchRawGachaFromUrl, POOL_TYPES } from "./gachaApi";
import { updateLeaderboard } from "./gachaLeaderboard";
import { GachaApiError, GachaLeaderboardEntry, GachaLogData, GachaRecord, isGachaPull } from "./gachaTypes";

interface SimPoolRecordChar {
  charId?: string;
  charName?: string;
}

interface SimPoolRecord {
  poolId: string;
  poolName: string;
  poolType?: string;
  lastSeenTs?: number;
  featuredSixStar?: SimPoolRecordChar;
  featuredFiveStars?: SimPoolRecordChar[];
}

function toTs(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch and merge gacha records using a stored linked account (no URL required).
 * Automatically detects server region if not already stored.
 */
export async function fetchAndMergeGachaLogFromAccount(
  db: CustomDatabase,
  accountCookie: string,
  hgId: string,
  provider: "hypergryph" | "gryphline",
  targetUid: string,
  onProgress?: (message: string) => void,
  locale?: string,
  avatarUrl?: string,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
) {
  // Extract raw token value from "ACCOUNT_TOKEN=xxx" cookie string
  const tokenMatch = accountCookie.match(/ACCOUNT_TOKEN=([^;]+)/);
  let accountToken = tokenMatch ? tokenMatch[1].trim() : accountCookie.trim();

  if (onProgress) onProgress("Authenticating with Endfield...");
  let u8Token: string;
  try {
    u8Token = await getEndfieldU8Token(accountToken, hgId, provider);
  } catch (firstErr: any) {
    // If the initial attempt fails with an HTTP 400/401, the ACCOUNT_TOKEN may be
    // stale. Try refreshing it via Skport and retry once.
    const isAuthError =
      firstErr?.response?.status === 400 ||
      firstErr?.response?.status === 401 ||
      (firstErr instanceof GachaApiError &&
        (firstErr.apiCode === 40100 || firstErr.apiCode === -1));
    if (!isAuthError) throw firstErr;

    if (onProgress) onProgress("Token expired, refreshing...");
    const refreshed = await refreshAccountToken(accountCookie);
    if (!refreshed) {
      throw new GachaApiError("Linked account login has expired", 40100);
    }

    accountToken = refreshed;
    try {
      u8Token = await getEndfieldU8Token(accountToken, hgId, provider);
    } catch (retryErr: any) {
      const status = retryErr?.response?.status;
      if (status === 400 || status === 401) {
        throw new GachaApiError("Linked account login has expired", 40100);
      }
      throw retryErr;
    }
  }

  // Reuse stored serverId, or auto-detect
  const dbKey = `GACHA_LOG_${targetUid}`;
  const existingData = await db.get<GachaLogData>(dbKey);
  let serverId = existingData?.info?.serverId;

  const apiDomain = `https://ef-webview.${provider}.com`;
  const lang = locale
    ? mapLocaleToLang(locale)
    : provider === "gryphline"
      ? "en-us"
      : "zh-cn";

  if (!serverId) {
    if (onProgress) onProgress("Detecting server region...");
    const serverCandidates = provider === "gryphline" ? ["3", "2", "1"] : ["1"];
    let firstValidServer: string | undefined;
    for (const candidate of serverCandidates) {
      try {
        const probeRes = await axios.get(`${apiDomain}/api/record/char`, {
          params: {
            token: u8Token,
            lang,
            server_id: candidate,
            pool_type: POOL_TYPES[0],
          },
        });
        if (probeRes.data.code === 0) {
          // Prefer a server that actually has records; fall back to first code-0 server
          const hasRecords =
            (probeRes.data.data?.list?.length ?? 0) > 0 ||
            probeRes.data.data?.hasMore === true;
          if (!firstValidServer) firstValidServer = candidate;
          if (hasRecords) {
            serverId = candidate;
            break;
          }
        }
      } catch {
        // try next
      }
    }
    // Fall back to the first server that returned code 0, even if it had no records
    if (!serverId) serverId = firstValidServer;
    if (!serverId) {
      throw new GachaApiError("Unable to detect server region", 40100);
    }
  }

  // Build a synthetic URL so we can reuse fetchAndMergeGachaLog directly
  const syntheticUrl = `${apiDomain}/page/gacha_?token=${encodeURIComponent(u8Token)}&server_id=${serverId}&lang=${lang}`;

  return fetchAndMergeGachaLog(
    db,
    syntheticUrl,
    onProgress,
    targetUid,
    locale,
    avatarUrl,
    displayName,
    accountIndex,
    gameNickname,
  );
}

/**
 * Detects whether there is a seqId gap between existing DB records and
 * newly fetched API records. Returns the oldest new record's seqId if a
 * gap exists (i.e. the API window no longer covers the tail of old data),
 * so pity counters can be reset at that boundary.
 */
function detectPityGapSeqId(
  existingList: GachaRecord[],
  newList: GachaRecord[],
): string | undefined {
  if (existingList.length === 0 || newList.length === 0) return undefined;

  const existingMaxSeqId = existingList.reduce(
    (max, r) => (Number(r.seqId) > max ? Number(r.seqId) : max),
    0,
  );
  const newMinSeqId = newList.reduce(
    (min, r) => (Number(r.seqId) < min ? Number(r.seqId) : min),
    Infinity,
  );

  // If the oldest new API record is newer than all existing records, the two
  // windows don't overlap — pulls between them are outside the 90-day limit
  // and therefore lost. Pity must restart from newMinSeqId.
  if (Number.isFinite(newMinSeqId) && newMinSeqId > existingMaxSeqId) {
    return String(newMinSeqId);
  }
  return undefined;
}

async function persistSimPoolRecordsFromLog(
  db: CustomDatabase,
  uid: string,
  data: GachaLogData,
) {
  const key = `SIM_POOL_RECORDS.${uid}`;
  const globalKey = "SIM_POOL_RECORDS.GLOBAL";
  const existing = (await db.get<Record<string, SimPoolRecord>>(key)) || {};
  const globalExisting =
    (await db.get<Record<string, SimPoolRecord>>(globalKey)) || {};
  const merged: Record<string, SimPoolRecord> = { ...existing };
  const globalMerged: Record<string, SimPoolRecord> = { ...globalExisting };

  const byPool = new Map<string, GachaRecord[]>();
  for (const rec of data.characterList || []) {
    if (!rec?.poolId) continue;
    if (!byPool.has(rec.poolId)) byPool.set(rec.poolId, []);
    byPool.get(rec.poolId)!.push(rec);
  }

  for (const [poolId, list] of byPool.entries()) {
    const sixCounter = new Map<
      string,
      { count: number; latestTs: number; name?: string }
    >();
    const fiveCounter = new Map<
      string,
      { count: number; latestTs: number; name?: string }
    >();
    let lastSeenTs = 0;
    let poolName = poolId;
    let poolType = "";

    for (const rec of list) {
      const ts = toTs(rec.gachaTs) || Math.floor(Number(rec.seqId || 0) / 1000);
      if (ts > lastSeenTs) lastSeenTs = ts;
      if (rec.poolName) poolName = rec.poolName;
      if (rec.poolType) poolType = rec.poolType;

      const id = String(rec.charId || "").trim();
      if (!id) continue;

      if (rec.rarity >= 6) {
        const old = sixCounter.get(id) || {
          count: 0,
          latestTs: 0,
          name: rec.charName,
        };
        sixCounter.set(id, {
          count: old.count + 1,
          latestTs: Math.max(old.latestTs, ts),
          name: rec.charName || old.name,
        });
      } else if (rec.rarity === 5) {
        const old = fiveCounter.get(id) || {
          count: 0,
          latestTs: 0,
          name: rec.charName,
        };
        fiveCounter.set(id, {
          count: old.count + 1,
          latestTs: Math.max(old.latestTs, ts),
          name: rec.charName || old.name,
        });
      }
    }

    const topSix = Array.from(sixCounter.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].latestTs - a[1].latestTs)
      .slice(0, 1)
      .map(([charId, meta]) => ({ charId, charName: meta.name }));

    const topFive = Array.from(fiveCounter.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].latestTs - a[1].latestTs)
      .slice(0, 2)
      .map(([charId, meta]) => ({ charId, charName: meta.name }));

    merged[poolId] = {
      poolId,
      poolName,
      poolType,
      lastSeenTs,
      featuredSixStar: topSix[0],
      featuredFiveStars: topFive,
    };

    const oldGlobal = globalMerged[poolId];
    if (!oldGlobal || (oldGlobal.lastSeenTs || 0) <= lastSeenTs) {
      globalMerged[poolId] = {
        poolId,
        poolName,
        poolType,
        lastSeenTs,
        featuredSixStar: topSix[0] || oldGlobal?.featuredSixStar,
        featuredFiveStars:
          topFive.length > 0 ? topFive : oldGlobal?.featuredFiveStars,
      };
    }
  }

  await db.set(key, merged);
  await db.set(globalKey, globalMerged);
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
  const rawFetched = await fetchRawGachaFromUrl(urlStr, onProgress, locale);
  const lang = rawFetched.lang;
  const serverId = rawFetched.serverId;
  let uid = targetUid || rawFetched.inferredUid;

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

  const characterList = rawFetched.characterList;
  const weaponList = rawFetched.weaponList;

  // 3. Detect data gap BEFORE merging (compare existing vs newly fetched)
  const charPityResetSeqId = detectPityGapSeqId(
    existingData.characterList,
    characterList,
  );
  const weaponPityResetSeqId = detectPityGapSeqId(
    existingData.weaponList,
    weaponList,
  );
  const hasDataGap = !!(charPityResetSeqId || weaponPityResetSeqId);

  // 4. Merge and persist
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
      charPityResetSeqId,
      weaponPityResetSeqId,
    },
  };

  await db.set(dbKey, updatedData);
  await persistSimPoolRecordsFromLog(db, uid, updatedData);

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
    totalChar: newCharList.filter(isGachaPull).length,
    totalWeapon: newWeaponList.filter(isGachaPull).length,
    hasDataGap,
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
  await persistSimPoolRecordsFromLog(db, targetUid, updatedData);
  if (sourceKey !== targetKey) {
    await db.delete(sourceKey);
  }

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
    if (sourceUid !== targetUid && lb[sourceUid]) {
      delete lb[sourceUid];
      await db.set("GACHA_LEADERBOARD_ENTRIES", lb);
    }
  } catch (e) {
    console.error(`[Leaderboard] Failed to remove guest log ${sourceUid}:`, e);
  }

  return updatedData;
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

  const start = startTime
    ? moment(/^\d+$/.test(startTime) ? Number(startTime) : startTime).valueOf()
    : 0;
  const end = endTime
    ? moment(/^\d+$/.test(endTime) ? Number(endTime) : endTime).valueOf()
    : Infinity;

  const filterFn = (r: GachaRecord) => {
    const rawTs = r.gachaTs;
    const ts =
      typeof rawTs === "string" && /^\d+$/.test(rawTs)
        ? Number(rawTs)
        : /^\d+$/.test(String(rawTs))
          ? Number(rawTs)
          : moment(rawTs).valueOf();
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