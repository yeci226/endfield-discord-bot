import axios from "axios";
import { CustomDatabase } from "./Database";
import { mapLocaleToLang } from "./skportApi";
import moment from "moment";

export class GachaApiError extends Error {
  apiCode: number;
  constructor(message: string, apiCode: number) {
    super(message);
    this.name = "GachaApiError";
    this.apiCode = apiCode;
  }
}

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
    // Pity reset boundaries: set when a data gap is detected between the previous
    // import and the current API fetch (records older than 90 days are inaccessible).
    // Pity counters restart from this seqId to prevent inflated/deflated pity readings.
    charPityResetSeqId?: string;
    weaponPityResetSeqId?: string;
  };
}

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

function parseRecordTs(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  const m = moment(v);
  return m.isValid() ? m.valueOf() : 0;
}

type RawFetchedGacha = {
  host: string;
  lang: string;
  serverId: string;
  apiDomain: string;
  inferredUid: string;
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
};

async function fetchRawGachaFromUrl(
  urlStr: string,
  onProgress?: (message: string) => void,
  locale?: string,
): Promise<RawFetchedGacha> {
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
  let inferredUid = `EF_${serverId}`;
  if (host.includes("hypergryph")) {
    inferredUid = `EF_CN_${serverId}`;
  }

  const characterList: GachaRecord[] = [];
  const weaponList: GachaRecord[] = [];

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
        throw new GachaApiError(
          data.msg || data.message || "API Error",
          data.code,
        );
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

  return {
    host,
    lang,
    serverId,
    apiDomain,
    inferredUid,
    characterList,
    weaponList,
  };
}

export interface GachaFingerprintMatch {
  uid: string;
  score: number;
  seqOverlap: number;
  timeSimilarity: number;
  poolSimilarity: number;
}

export interface GachaFingerprintResult {
  recommendedUid?: string;
  confidence: number;
  selectedUid?: string;
  selectedScore?: number;
  compared: number;
  matches: GachaFingerprintMatch[];
  incomingSummary: {
    total: number;
    startTs: number;
    endTs: number;
  };
}

function buildPoolDistMap(list: GachaRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of list) {
    if (isPullFree(r)) continue;
    const key = String(r.poolId || "unknown");
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  if (keys.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = a.get(k) || 0;
    const bv = b.get(k) || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function seqOverlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let hit = 0;
  for (const v of b) {
    if (sa.has(v)) hit++;
  }
  return hit / Math.min(a.length, b.length);
}

function timeWindowSimilarity(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const centerA = (aStart + aEnd) / 2;
  const centerB = (bStart + bEnd) / 2;
  const spanA = Math.max(1, aEnd - aStart);
  const spanB = Math.max(1, bEnd - bStart);
  const centerDiff = Math.abs(centerA - centerB);
  const spanDiff = Math.abs(spanA - spanB);
  const normCenter = Math.max(spanA, spanB, 1000 * 60 * 60 * 24 * 7);
  const centerScore = Math.max(0, 1 - centerDiff / normCenter);
  const spanScore = Math.max(0, 1 - spanDiff / Math.max(spanA, spanB));
  return centerScore * 0.7 + spanScore * 0.3;
}

export async function analyzeGachaImportFingerprint(
  db: CustomDatabase,
  urlStr: string,
  candidateUids: string[],
  selectedUid?: string,
  locale?: string,
): Promise<GachaFingerprintResult> {
  const raw = await fetchRawGachaFromUrl(urlStr, undefined, locale);
  const incomingList = [...raw.characterList, ...raw.weaponList].sort(
    (a, b) => Number(b.seqId) - Number(a.seqId),
  );

  const incomingSeqs = incomingList.slice(0, 300).map((r) => String(r.seqId));
  const incomingPoolDist = buildPoolDistMap(incomingList);
  const incomingTs = incomingList
    .map((r) => parseRecordTs(r.gachaTs))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const incomingStart = incomingTs[0] || 0;
  const incomingEnd = incomingTs[incomingTs.length - 1] || 0;

  const matches: GachaFingerprintMatch[] = [];
  const uniqueCandidates = Array.from(new Set(candidateUids.filter(Boolean)));

  for (const uid of uniqueCandidates) {
    const existing = await db.get<GachaLogData>(`GACHA_LOG_${uid}`);
    if (!existing) continue;
    const existingList = [
      ...existing.characterList,
      ...existing.weaponList,
    ].sort((a, b) => Number(b.seqId) - Number(a.seqId));
    if (existingList.length === 0) continue;

    const existingSeqs = existingList.slice(0, 300).map((r) => String(r.seqId));
    const seqOverlap = seqOverlapRatio(incomingSeqs, existingSeqs);

    const existingPoolDist = buildPoolDistMap(existingList);
    const poolSimilarity = cosineSimilarity(incomingPoolDist, existingPoolDist);

    const existingTs = existingList
      .map((r) => parseRecordTs(r.gachaTs))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const existingStart = existingTs[0] || 0;
    const existingEnd = existingTs[existingTs.length - 1] || 0;
    const timeSimilarity = timeWindowSimilarity(
      incomingStart,
      incomingEnd,
      existingStart,
      existingEnd,
    );

    const score =
      seqOverlap * 0.55 + poolSimilarity * 0.3 + timeSimilarity * 0.15;

    matches.push({
      uid,
      score,
      seqOverlap,
      timeSimilarity,
      poolSimilarity,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const selected = selectedUid
    ? matches.find((m) => m.uid === selectedUid)
    : undefined;

  return {
    recommendedUid: best?.uid,
    confidence: best?.score || 0,
    selectedUid,
    selectedScore: selected?.score,
    compared: matches.length,
    matches,
    incomingSummary: {
      total: incomingList.length,
      startTs: incomingStart,
      endTs: incomingEnd,
    },
  };
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
    totalChar: newCharList.length,
    totalWeapon: newWeaponList.length,
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

/**
 * Retrospectively sync all existing gacha logs in the database to the leaderboard
 */
export async function syncExistingLogsToLeaderboard(db: CustomDatabase) {
  const logIds = await db.findIdsByPrefix("GACHA_LOG_");
  console.log(
    `[Leaderboard Sync] Found ${logIds.length} existing logs to sync.`,
  );

  for (const id of logIds) {
    const uid = id.replace("GACHA_LOG_", "");
    try {
      const data = await db.get<GachaLogData>(id);
      if (data) {
        await updateLeaderboard(db, uid, data);
      }
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
    pityResetSeqId?: string,
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
            const recordCid = String(
              record.charId || record.weaponId || "",
            ).replace("icon_", "");

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
                const recordCid = String(
                  record.charId || record.weaponId || "",
                ).replace("icon_", "");
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

  const charStats = calculateDetailedHistory(
    data.characterList,
    "char",
    data.info.charPityResetSeqId,
  );
  const weaponStats = calculateDetailedHistory(
    data.weaponList,
    "weapon",
    data.info.weaponPityResetSeqId,
  );

  return {
    uid: data.info.uid,
    char: charStats,
    weapon: weaponStats,
  };
}
