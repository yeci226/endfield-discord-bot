import moment from "moment";
import { CustomDatabase } from "../../utils/Database";
import axios from "axios";
import { mapLocaleToLang, refreshAccountToken } from "../../utils/skportApi";
import {
  getEndfieldU8Token,
  fetchRawGachaFromUrl,
  GachaStopAt,
  HTTP_OPTIONS,
  IncompleteFetch,
  POOL_TYPES,
  RawFetchedGacha,
} from "./gachaApi";
import { lbKey, updateLeaderboard } from "./gachaLeaderboard";
import { GachaApiError, GachaLogData, GachaRecord, isGachaPull } from "./gachaTypes";

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
  options?: FetchAndMergeOptions,
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
  let serverId = readStoredServerId(db, targetUid);

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
          ...HTTP_OPTIONS,
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
    options,
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

function isCharIncomplete(item: IncompleteFetch): boolean {
  return item.poolType !== "WeaponPool";
}

/**
 * The records of a list that may take part in pity-gap detection: a pool whose
 * fetch was cut short only returned its newest pages, so comparing it with the
 * stored log would invent a gap. Character pools are told apart by poolType,
 * weapon pools by poolId; when the weapon pool list itself failed there is
 * nothing trustworthy at all.
 */
export function recordsForGapDetection(
  list: GachaRecord[],
  incomplete: IncompleteFetch[] | undefined,
  kind: "character" | "weapon",
): GachaRecord[] {
  if (!incomplete || incomplete.length === 0) return list;
  if (kind === "character") {
    const bad = new Set(
      incomplete.filter(isCharIncomplete).map((i) => i.poolType),
    );
    return bad.size === 0 ? list : list.filter((r) => !bad.has(r.poolType));
  }
  const weapon = incomplete.filter((i) => !isCharIncomplete(i));
  if (weapon.length === 0) return list;
  if (weapon.some((i) => i.poolId == null)) return [];
  const bad = new Set(weapon.map((i) => String(i.poolId)));
  return list.filter((r) => !bad.has(String(r.poolId)));
}

/** Pity-gap markers for one import, leaving out the pools whose fetch was incomplete. Pure. */
export function detectPityGaps(
  existing: { characterList: GachaRecord[]; weaponList: GachaRecord[] },
  fetched: { characterList: GachaRecord[]; weaponList: GachaRecord[] },
  incomplete?: IncompleteFetch[],
): PityResetMarkers {
  return {
    charPityResetSeqId: detectPityGapSeqId(
      recordsForGapDetection(existing.characterList, incomplete, "character"),
      recordsForGapDetection(fetched.characterList, incomplete, "character"),
    ),
    weaponPityResetSeqId: detectPityGapSeqId(
      recordsForGapDetection(existing.weaponList, incomplete, "weapon"),
      recordsForGapDetection(fetched.weaponList, incomplete, "weapon"),
    ),
  };
}

/**
 * Which lists of a stored log may be fetched incrementally, as the stop
 * predicates for the importer (undefined = full fetch of everything).
 * A list qualifies only when its last import was positively recorded as
 * complete, it has no pending pity marker (a gap can only close through a full
 * fetch) and it has records. Records are matched by seqId against the stored
 * set; seqIds are not assumed to follow one global order.
 */
export function decideStopAt(
  stored: GachaLogData | null | undefined,
  opts: { forceFull?: boolean } = {},
): GachaStopAt | undefined {
  if (opts.forceFull || !stored || !stored.info || !stored.info.lang) {
    return undefined;
  }
  const known = (list: GachaRecord[] | undefined) => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const ids = new Set(list.map((r) => String(r.seqId)));
    return (seqId: string) => ids.has(String(seqId));
  };
  const character =
    stored.info.charFetchComplete === true && !stored.info.charPityResetSeqId
      ? known(stored.characterList)
      : undefined;
  const weapon =
    stored.info.weaponFetchComplete === true &&
    !stored.info.weaponPityResetSeqId
      ? known(stored.weaponList)
      : undefined;
  if (!character && !weapon) return undefined;
  return { character, weapon, lang: stored.info.lang };
}

/** Reads the stored log only when its small info block says an incremental import is possible. */
function readLogForIncremental(
  db: CustomDatabase,
  uid: string,
): Promise<GachaLogData | null> {
  const token = db.getRowToken(`GACHA_LOG_${uid}`, "$.info");
  if (!token?.field) return Promise.resolve(null);
  try {
    const info = JSON.parse(token.field) as GachaLogData["info"];
    const charOk = info.charFetchComplete === true && !info.charPityResetSeqId;
    const weaponOk =
      info.weaponFetchComplete === true && !info.weaponPityResetSeqId;
    if (!charOk && !weaponOk) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return db.get<GachaLogData>(`GACHA_LOG_${uid}`);
}

/** Strictly increasing write stamp for a log row (never equal to or below the previous one). */
export function nextUpdatedAt(
  previous: number | undefined,
  now: number = Date.now(),
): number {
  const prev = Number(previous);
  return Math.max(now, (Number.isFinite(prev) ? prev : 0) + 1);
}

/** Merges two record lists by seqId (incoming wins), newest first. */
export function mergeGachaRecords(
  existing: GachaRecord[] | undefined,
  incoming: GachaRecord[] | undefined,
): GachaRecord[] {
  const map = new Map<string, GachaRecord>();
  (existing || []).forEach((r) => map.set(String(r.seqId), r));
  (incoming || []).forEach((r) => map.set(String(r.seqId), r));
  return Array.from(map.values()).sort(
    (a, b) => Number(b.seqId) - Number(a.seqId),
  );
}

export interface PityResetMarkers {
  charPityResetSeqId?: string;
  weaponPityResetSeqId?: string;
}

function resolvePityMarker(
  previous: string | undefined,
  detected: string | undefined,
  merged: GachaRecord[],
  existing: GachaRecord[] | undefined,
): string | undefined {
  const candidates = [previous, detected]
    .map((v) => (v == null ? NaN : Number(v)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return undefined;
  const marker = Math.max(...candidates);
  const ids = merged.map((r) => Number(r.seqId)).filter(Number.isFinite);
  // The record the marker points at is gone (cleared range): nothing to reset at.
  if (!ids.some((id) => id >= marker)) return undefined;
  // Nothing precedes it: pity is already zero there, the marker has no effect.
  if (!ids.some((id) => id < marker)) return undefined;
  if (existing) {
    // The gap is the stretch between the last record before the marker and the
    // marker. Records that now fall inside it mean the gap has been bridged.
    let before = -Infinity;
    for (const r of existing) {
      const id = Number(r.seqId);
      if (id < marker && id > before) before = id;
    }
    if (before > -Infinity && ids.some((id) => id > before && id < marker)) {
      return undefined;
    }
  }
  return String(marker);
}

/**
 * Pity reset markers after a merge. A marker means "records older than this
 * seqId are separated from the newer ones by pulls we can never see", so it
 * stays until the merge proves otherwise: it is dropped when the record it
 * points at is gone, when nothing precedes it, or when records now fill the
 * gap it described (`opts.existing` = the lists before the merge). A gap newly
 * detected by this import (`opts.detected`) is combined with the old marker;
 * the later boundary wins because pity restarts there.
 */
export function mergePityResetMarkers(
  existingInfo: PityResetMarkers | undefined | null,
  mergedRecords: { characterList: GachaRecord[]; weaponList: GachaRecord[] },
  opts: {
    detected?: PityResetMarkers;
    existing?: { characterList?: GachaRecord[]; weaponList?: GachaRecord[] };
  } = {},
): PityResetMarkers {
  return {
    charPityResetSeqId: resolvePityMarker(
      existingInfo?.charPityResetSeqId,
      opts.detected?.charPityResetSeqId,
      mergedRecords.characterList,
      opts.existing?.characterList,
    ),
    weaponPityResetSeqId: resolvePityMarker(
      existingInfo?.weaponPityResetSeqId,
      opts.detected?.weaponPityResetSeqId,
      mergedRecords.weaponList,
      opts.existing?.weaponList,
    ),
  };
}

/** The per-pool "which characters were featured" summary the simulator reads. Pure. */
export function computeSimPoolRecords(
  data: GachaLogData,
): Record<string, SimPoolRecord> {
  const result: Record<string, SimPoolRecord> = {};

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

    result[poolId] = {
      poolId,
      poolName,
      poolType,
      lastSeenTs,
      featuredSixStar: topSix[0],
      featuredFiveStars: topFive,
    };
  }
  return result;
}

type StoreView = {
  get<T = any>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
};

/** Merges computed pool records into the per-UID row and the shared GLOBAL row, inside the caller's transaction. */
function applySimPoolRecords(
  store: StoreView,
  uid: string,
  computed: Record<string, SimPoolRecord>,
) {
  if (Object.keys(computed).length === 0) return;
  const key = `SIM_POOL_RECORDS.${uid}`;
  const globalKey = "SIM_POOL_RECORDS.GLOBAL";
  const merged = { ...(store.get<Record<string, SimPoolRecord>>(key) || {}) };
  const globalMerged = {
    ...(store.get<Record<string, SimPoolRecord>>(globalKey) || {}),
  };

  for (const [poolId, record] of Object.entries(computed)) {
    merged[poolId] = record;
    const oldGlobal = globalMerged[poolId];
    if (!oldGlobal || (oldGlobal.lastSeenTs || 0) <= (record.lastSeenTs || 0)) {
      globalMerged[poolId] = {
        ...record,
        featuredSixStar: record.featuredSixStar || oldGlobal?.featuredSixStar,
        featuredFiveStars:
          record.featuredFiveStars && record.featuredFiveStars.length > 0
            ? record.featuredFiveStars
            : oldGlobal?.featuredFiveStars,
      };
    }
  }
  store.set(key, merged);
  store.set(globalKey, globalMerged);
}

function emptyLog(uid: string, lang: string): GachaLogData {
  return {
    characterList: [],
    weaponList: [],
    info: { uid, lang, export_timestamp: 0 },
  };
}

function normalizeStored(
  stored: GachaLogData | null,
  uid: string,
  lang: string,
): GachaLogData {
  if (!stored || typeof stored !== "object") return emptyLog(uid, lang);
  return {
    ...stored,
    characterList: Array.isArray(stored.characterList) ? stored.characterList : [],
    weaponList: Array.isArray(stored.weaponList) ? stored.weaponList : [],
    info: stored.info || { uid, lang, export_timestamp: 0 },
  };
}

export interface FetchAndMergeOptions {
  /** Page every pool to the end even when the stored log would allow an incremental import. */
  forceFull?: boolean;
}

export interface CommitFetchedExtras {
  avatarUrl?: string;
  gameNickname?: string;
}

/**
 * Merges freshly fetched records into the stored log in ONE transaction: the
 * stored log is re-read inside it, so a load that finished on another cluster
 * while this one was waiting for the network is merged, not overwritten.
 * Synchronous on purpose (no await inside a transaction).
 */
export function commitFetchedGachaLog(
  db: CustomDatabase,
  uid: string,
  rawFetched: Pick<
    RawFetchedGacha,
    "lang" | "serverId" | "characterList" | "weaponList"
  > &
    Partial<Pick<RawFetchedGacha, "incomplete" | "incremental">>,
  extras: CommitFetchedExtras,
): { data: GachaLogData; hasDataGap: boolean } {
  const dbKey = `GACHA_LOG_${uid}`;
  return db.transaction((store) => {
    const existing = normalizeStored(
      store.get<GachaLogData>(dbKey),
      uid,
      rawFetched.lang,
    );

    // Gap detection compares what is stored NOW with what was fetched, leaving
    // out pools whose fetch was cut short (a truncated pool is not a gap).
    const detected = detectPityGaps(existing, rawFetched, rawFetched.incomplete);
    const hasDataGap = !!(
      detected.charPityResetSeqId || detected.weaponPityResetSeqId
    );

    const characterList = mergeGachaRecords(
      existing.characterList,
      rawFetched.characterList,
    );
    const weaponList = mergeGachaRecords(
      existing.weaponList,
      rawFetched.weaponList,
    );
    const markers = mergePityResetMarkers(
      existing.info,
      { characterList, weaponList },
      { detected, existing },
    );

    // A list is "complete" when nothing in it failed AND it was either paged to
    // the end now or was already complete in the row as it is right now (a
    // clear or an incomplete import on another cluster may have changed that).
    const incompleteNow = rawFetched.incomplete ?? [];
    const incremental = rawFetched.incremental ?? {
      character: false,
      weapon: false,
    };
    const charFetchComplete =
      !incompleteNow.some(isCharIncomplete) &&
      (!incremental.character || existing.info.charFetchComplete === true);
    const weaponFetchComplete =
      !incompleteNow.some((i) => !isCharIncomplete(i)) &&
      (!incremental.weapon || existing.info.weaponFetchComplete === true);

    const data: GachaLogData = {
      characterList,
      weaponList,
      info: {
        uid,
        lang: rawFetched.lang,
        serverId: rawFetched.serverId,
        nickname:
          extras.gameNickname && extras.gameNickname !== uid
            ? extras.gameNickname
            : existing.info.nickname && existing.info.nickname !== uid
              ? existing.info.nickname
              : undefined,
        avatarUrl: extras.avatarUrl || existing.info.avatarUrl,
        export_timestamp: Date.now(),
        charPityResetSeqId: markers.charPityResetSeqId,
        weaponPityResetSeqId: markers.weaponPityResetSeqId,
        updatedAt: nextUpdatedAt(existing.info.updatedAt),
        charFetchComplete,
        weaponFetchComplete,
      },
    };

    store.set(dbKey, data);
    applySimPoolRecords(store, uid, computeSimPoolRecords(data));
    return { data, hasDataGap };
  });
}

/** serverId of a stored log without parsing the (up to 2.6 MB) row. */
function readStoredServerId(db: CustomDatabase, uid: string): string | undefined {
  const key = `GACHA_LOG_${uid}`;
  const row = db
    .findFieldByPrefix(key, "$.info.serverId")
    .find((r) => r.id === key);
  return row?.field != null ? String(row.field) : undefined;
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
  options?: FetchAndMergeOptions,
) {
  // Incremental import: only when the target UID is known up front and its
  // stored log says every condition in decideStopAt holds.
  const stopAt =
    targetUid && !options?.forceFull
      ? decideStopAt(await readLogForIncremental(db, targetUid))
      : undefined;

  // Network first, outside any transaction.
  const rawFetched = await fetchRawGachaFromUrl(
    urlStr,
    onProgress,
    locale,
    stopAt ? { stopAt } : undefined,
  );
  const uid = targetUid || rawFetched.inferredUid;

  const { data: updatedData, hasDataGap } = commitFetchedGachaLog(
    db,
    uid,
    rawFetched,
    { avatarUrl, gameNickname },
  );

  // The leaderboard row follows the log write (it needs async statistics, so it
  // is a second, guarded transaction rather than part of the first).
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
    totalChar: updatedData.characterList.filter(isGachaPull).length,
    totalWeapon: updatedData.weaponList.filter(isGachaPull).length,
    hasDataGap,
    /** Parts of the history that could not be fetched (empty = complete). */
    incomplete: rawFetched.incomplete,
    /** Which lists stopped paging at the first stored record. */
    incremental: rawFetched.incremental,
    data: updatedData,
  };
}

/**
 * Moves a guest log into a real UID's log in one transaction (read both, merge,
 * write target, delete source log and source leaderboard row).
 */
export function commitGachaLogMigration(
  db: CustomDatabase,
  sourceUid: string,
  targetUid: string,
): GachaLogData | null {
  const sourceKey = `GACHA_LOG_${sourceUid}`;
  const targetKey = `GACHA_LOG_${targetUid}`;
  return db.transaction((store) => {
    const stored = store.get<GachaLogData>(sourceKey);
    if (!stored) return null;
    const sourceData = normalizeStored(stored, sourceUid, "en-us");
    const targetData = normalizeStored(
      store.get<GachaLogData>(targetKey),
      targetUid,
      sourceData.info.lang,
    );

    const characterList = mergeGachaRecords(
      targetData.characterList,
      sourceData.characterList,
    );
    const weaponList = mergeGachaRecords(
      targetData.weaponList,
      sourceData.weaponList,
    );
    // Both logs may carry a gap marker; the later boundary is the one that matters.
    const markers = mergePityResetMarkers(
      {
        charPityResetSeqId: laterSeqId(
          targetData.info.charPityResetSeqId,
          sourceData.info.charPityResetSeqId,
        ),
        weaponPityResetSeqId: laterSeqId(
          targetData.info.weaponPityResetSeqId,
          sourceData.info.weaponPityResetSeqId,
        ),
      },
      { characterList, weaponList },
    );

    const updatedData: GachaLogData = {
      characterList,
      weaponList,
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
        charPityResetSeqId: markers.charPityResetSeqId,
        weaponPityResetSeqId: markers.weaponPityResetSeqId,
        updatedAt: nextUpdatedAt(targetData.info.updatedAt),
        // Two logs were joined: whatever lies between them is only restored by a full fetch.
        charFetchComplete: false,
        weaponFetchComplete: false,
      },
    };

    store.set(targetKey, updatedData);
    applySimPoolRecords(store, targetUid, computeSimPoolRecords(updatedData));
    if (sourceKey !== targetKey) {
      store.delete(sourceKey);
      store.delete(lbKey(sourceUid));
    }
    return updatedData;
  });
}

function laterSeqId(a?: string, b?: string): string | undefined {
  const na = a == null ? NaN : Number(a);
  const nb = b == null ? NaN : Number(b);
  if (!Number.isFinite(na) && !Number.isFinite(nb)) return undefined;
  if (!Number.isFinite(na)) return b;
  if (!Number.isFinite(nb)) return a;
  return na >= nb ? a : b;
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
  const updatedData = commitGachaLogMigration(db, sourceUid, targetUid);
  if (!updatedData) return null;

  // Update leaderboard for target (the source row was removed with its log).
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

  // Read, filter and write in one transaction so a concurrent import is not lost.
  const outcome = db.transaction((store) => {
    const stored = store.get<GachaLogData>(dbKey);
    if (!stored) return null;
    const data = normalizeStored(stored, uid, "en-us");
    const characterList = data.characterList.filter(filterFn);
    const weaponList = data.weaponList.filter(filterFn);

    if (characterList.length === 0 && weaponList.length === 0) {
      store.delete(dbKey);
      store.delete(lbKey(uid)); // log and board row go together
      return { data: null as GachaLogData | null };
    }
    const markers = mergePityResetMarkers(
      data.info,
      { characterList, weaponList },
    );
    const updated: GachaLogData = {
      ...data,
      characterList,
      weaponList,
      info: {
        ...data.info,
        charPityResetSeqId: markers.charPityResetSeqId,
        weaponPityResetSeqId: markers.weaponPityResetSeqId,
        updatedAt: nextUpdatedAt(data.info.updatedAt),
        // A range was cut out of the middle: only a full fetch brings it back.
        charFetchComplete: false,
        weaponFetchComplete: false,
      },
    };
    store.set(dbKey, updated);
    return { data: updated as GachaLogData | null };
  });

  if (!outcome) return false;
  if (outcome.data) await updateLeaderboard(db, uid, outcome.data);
  return true;
}
