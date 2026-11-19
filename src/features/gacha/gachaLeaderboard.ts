import { CustomDatabase } from "../../utils/Database";
import { getGachaStats } from "./gachaStatsEngine";
import { startGachaCacheJobs } from "./gachaStatsCache";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord, isGachaPull, isPullFree } from "./gachaTypes";

function indexGachaLogRecords(
  data: GachaLogData,
): Map<string, string> | undefined {
  const indexed = new Map<string, string>();
  for (const [kind, records] of [
    ["char", data.characterList],
    ["weapon", data.weaponList],
  ] as const) {
    if (!Array.isArray(records)) return undefined;
    for (const record of records) {
      const seqId = String(record?.seqId ?? "");
      if (!seqId) return undefined;
      const key = `${kind}:${seqId}`;
      if (indexed.has(key)) return undefined;
      indexed.set(
        key,
        JSON.stringify([
          record.charId ?? "",
          record.weaponId ?? "",
          record.rarity ?? "",
          String(record.gachaTs ?? ""),
          record.poolId ?? "",
          Boolean(record.isFree),
        ]),
      );
    }
  }
  return indexed;
}

function isGachaLogSubset(
  candidate: GachaLogData,
  superset: GachaLogData,
): boolean {
  const candidateRecords = indexGachaLogRecords(candidate);
  const supersetRecords = indexGachaLogRecords(superset);
  if (
    !candidateRecords ||
    !supersetRecords ||
    candidateRecords.size === 0 ||
    candidateRecords.size > supersetRecords.size
  )
    return false;
  for (const [key, value] of candidateRecords) {
    if (supersetRecords.get(key) !== value) return false;
  }
  return true;
}

/** What the alias check needs from the database: the logs, and (optionally) a cheap version token to cache by. */
export type AliasDedupDb = Pick<CustomDatabase, "get"> &
  Partial<Pick<CustomDatabase, "getRowToken">>;

/** Outcome of comparing the two logs of one EF / EF_CN pair; independent of the board rows. */
interface AliasVerdict {
  globalIsSubset: boolean;
  cnIsSubset: boolean;
}

const aliasVerdicts = new WeakMap<
  object,
  Map<string, { tokens: string; verdict: AliasVerdict | null }>
>();

function logToken(db: AliasDedupDb, uid: string): string | null {
  const t = db.getRowToken?.(`GACHA_LOG_${uid}`, "$.info.updatedAt");
  return t ? `${t.length}:${t.field ?? ""}` : null;
}

/**
 * Compares the two logs of an alias pair (null = not a comparable pair). The
 * verdict is cached per pair, keyed by both log rows' version tokens
 * (stored length + info.updatedAt), so a view parses the logs again only after
 * one of them changed. Without getRowToken nothing is cached.
 */
async function aliasVerdict(
  db: AliasDedupDb,
  globalUid: string,
  cnUid: string,
  rawUid: string,
): Promise<AliasVerdict | null> {
  const tokens =
    db.getRowToken
      ? [logToken(db, globalUid), logToken(db, cnUid)]
      : [null, null];
  const cacheable = tokens[0] !== null && tokens[1] !== null;
  const pairKey = `${globalUid}|${cnUid}`;
  let perDb = aliasVerdicts.get(db);
  if (cacheable) {
    const hit = perDb?.get(pairKey);
    if (hit && hit.tokens === tokens.join("|")) return hit.verdict;
  }

  const [globalData, cnData] = await Promise.all([
    db.get<GachaLogData>(`GACHA_LOG_${globalUid}`),
    db.get<GachaLogData>(`GACHA_LOG_${cnUid}`),
  ]);
  let verdict: AliasVerdict | null = null;
  if (globalData && cnData) {
    const normalizeUid = (uid: string | undefined) =>
      String(uid || "")
        .replace(/^EF_CN_/, "")
        .replace(/^EF_/, "");
    if (
      normalizeUid(globalData.info?.uid) === rawUid &&
      normalizeUid(cnData.info?.uid) === rawUid &&
      globalData.info?.serverId &&
      String(globalData.info.serverId) === String(cnData.info?.serverId)
    ) {
      verdict = {
        globalIsSubset: isGachaLogSubset(globalData, cnData),
        cnIsSubset: isGachaLogSubset(cnData, globalData),
      };
    }
  }
  if (cacheable) {
    if (!perDb) {
      perDb = new Map();
      aliasVerdicts.set(db, perDb);
    }
    perDb.set(pairKey, { tokens: tokens.join("|"), verdict });
  }
  return verdict;
}

/** Filters duplicate EF/EF_CN rows only when one same-role pull history is a subset of the other. */
export async function deduplicateLeaderboardAliases(
  db: AliasDedupDb,
  entries: Record<string, GachaLeaderboardEntry>,
): Promise<Record<string, GachaLeaderboardEntry>> {
  const filtered = { ...entries };
  for (const cnUid of Object.keys(filtered)) {
    const match = /^EF_CN_(\d+)$/.exec(cnUid);
    if (!match) continue;
    const rawUid = match[1];
    const globalUid = `EF_${rawUid}`;
    if (!filtered[globalUid]) continue;

    const verdict = await aliasVerdict(db, globalUid, cnUid, rawUid);
    if (!verdict) continue;
    const { globalIsSubset, cnIsSubset } = verdict;
    if (!globalIsSubset && !cnIsSubset) continue;

    const removeUid =
      globalIsSubset && cnIsSubset
        ? filtered[globalUid].lastUpdate >= filtered[cnUid].lastUpdate
          ? cnUid
          : globalUid
        : globalIsSubset
          ? globalUid
          : cnUid;
    delete filtered[removeUid];
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Row-per-UID leaderboard storage
// ---------------------------------------------------------------------------

/** One row per UID: `GACHA_LB.<uid>`. */
export const LB_PREFIX = "GACHA_LB.";
/** The old single-row blob. Read once by the migration, never written again. */
export const LB_BLOB_KEY = "GACHA_LEADERBOARD_ENTRIES";
/** Done-marker of the blob migration. Deliberately NOT under LB_PREFIX. */
export const LB_MIGRATION_MARKER = "GACHA_LB_MIGRATED";
/** Bump when the meaning of the stored numbers changes; older rows are recomputed in the background. */
export const LEADERBOARD_METRICS_VERSION = 2;
export const MAX_GUILDS_PER_ENTRY = 50;
export const LB_MIGRATION_BATCH = 200; // <= 500 per the plan; 200 keeps one batch near 30 ms

export const lbKey = (uid: string) => `${LB_PREFIX}${uid}`;

/** Guest logs and the "no UID" placeholder never appear on the board. */
export function isLeaderboardEligibleUid(uid: string): boolean {
  return !!uid && !uid.startsWith("EF_GUEST_") && uid !== "EF_undefined";
}

type StoreView = {
  get<T = any>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
};

/** Exact-key existence without parsing the (up to 2.6 MB) row. keys() is a prefix scan, hence the equality check. */
function hasKey(store: StoreView, key: string): boolean {
  return store.keys(key).includes(key);
}

const setImmediateTick = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// In-process cache of the de-duplicated board
// ---------------------------------------------------------------------------

/** How long a process reuses its parsed, de-duplicated board (other processes' writes show up after this). */
export const LEADERBOARD_CACHE_TTL_MS = 60_000;

const boardCache = new WeakMap<
  object,
  { at: number; entries: GachaLeaderboardEntry[] }
>();
const boardGeneration = new WeakMap<object, number>();

/**
 * Forget the cached board of this process. Called by everything in this
 * process that writes or deletes a `GACHA_LB.*` row, so the writer sees its
 * own change immediately (other processes catch up within the TTL).
 */
export function invalidateLeaderboardCache(db: object): void {
  boardCache.delete(db);
  boardGeneration.set(db, (boardGeneration.get(db) ?? 0) + 1);
}

export interface LeaderboardMigrationResult {
  status: "migrated" | "already-done" | "no-blob";
  migrated: number;
  skipped: number;
  batches: number;
  /** Longest single synchronous batch (the blob parse is separate: parseMs). */
  maxBatchMs: number;
  parseMs: number;
}

export interface LeaderboardMigrationOptions {
  batchSize?: number;
  /** Called after each committed batch (tests use it to interrupt or to race a writer). */
  afterBatch?: (batchIndex: number) => void | Promise<void>;
}

/**
 * Copies the old `GACHA_LEADERBOARD_ENTRIES` blob into `GACHA_LB.<uid>` rows.
 * Idempotent (done-marker), resumable (a crash leaves committed batches and no
 * marker), never overwrites an existing row, never resurrects a UID whose log
 * is gone, and never touches the blob.
 */
export async function migrateLeaderboardBlob(
  db: CustomDatabase,
  opts: LeaderboardMigrationOptions = {},
): Promise<LeaderboardMigrationResult> {
  const batchSize = Math.max(1, opts.batchSize ?? LB_MIGRATION_BATCH);
  return db.withKeyLock(LB_MIGRATION_MARKER, async () => {
    const result: LeaderboardMigrationResult = {
      status: "migrated",
      migrated: 0,
      skipped: 0,
      batches: 0,
      maxBatchMs: 0,
      parseMs: 0,
    };
    if (await db.get(LB_MIGRATION_MARKER)) {
      return { ...result, status: "already-done" };
    }

    const parseStart = Date.now();
    const blob = await db.get<Record<string, GachaLeaderboardEntry>>(LB_BLOB_KEY);
    result.parseMs = Date.now() - parseStart;
    if (!blob || typeof blob !== "object") {
      await db.set(LB_MIGRATION_MARKER, { done: true, at: Date.now(), migrated: 0 });
      return { ...result, status: "no-blob" };
    }

    const uids = Object.keys(blob);
    for (let start = 0; start < uids.length; start += batchSize) {
      const slice = uids.slice(start, start + batchSize);
      const t0 = Date.now();
      const counts = db.transaction((store) => {
        let migrated = 0;
        let skipped = 0;
        for (const uid of slice) {
          const old = blob[uid];
          if (
            !isLeaderboardEligibleUid(uid) ||
            !old ||
            typeof old !== "object" ||
            !old.stats ||
            typeof old.stats !== "object" ||
            hasKey(store, lbKey(uid)) || // never overwrite a row the new code wrote
            !hasKey(store, `GACHA_LOG_${uid}`) // log cleared/deleted/migrated since
          ) {
            skipped++;
            continue;
          }
          store.set(lbKey(uid), {
            ...old,
            uid,
            guilds: Array.isArray((old as any).guilds)
              ? (old as any).guilds.map(String).slice(-MAX_GUILDS_PER_ENTRY)
              : [],
            updatedAt: Number(old.lastUpdate) || 0,
          } satisfies GachaLeaderboardEntry);
          migrated++;
        }
        return { migrated, skipped };
      });
      if (counts.migrated > 0) invalidateLeaderboardCache(db);
      result.migrated += counts.migrated;
      result.skipped += counts.skipped;
      result.maxBatchMs = Math.max(result.maxBatchMs, Date.now() - t0);
      if (opts.afterBatch) await opts.afterBatch(result.batches);
      result.batches++;
      await setImmediateTick();
    }

    await db.set(LB_MIGRATION_MARKER, {
      done: true,
      at: Date.now(),
      migrated: result.migrated,
      skipped: result.skipped,
    });
    return result;
  });
}

const migrationRuns = new WeakMap<CustomDatabase, Promise<unknown>>();

/** Runs the migration at most once per process (cheap no-op afterwards). Readers call this so no startup hook is required. */
export async function ensureLeaderboardMigrated(db: CustomDatabase): Promise<void> {
  let run = migrationRuns.get(db);
  if (!run) {
    run = migrateLeaderboardBlob(db);
    migrationRuns.set(db, run);
    run.catch(() => migrationRuns.delete(db)); // retry next time
  }
  try {
    await run;
  } catch (e) {
    console.error("[Leaderboard] Blob migration failed:", e);
  }
}

/**
 * The board: every leaderboard row with duplicate EF / EF_CN aliases already
 * removed (see deduplicateLeaderboardAliases), cached in this process for 60 s
 * and dropped at once when this process writes a row. Returns shallow copies,
 * so a caller that sets a top-level field (e.g. a fresher avatar) cannot change
 * what the next caller gets; the nested `stats` objects are shared: read-only.
 * `fresh: true` skips the cache (and refills it).
 */
export async function readLeaderboardEntries(
  db: CustomDatabase,
  opts: { fresh?: boolean; now?: number } = {},
): Promise<GachaLeaderboardEntry[]> {
  const now = opts.now ?? Date.now();
  if (!opts.fresh) {
    const cached = boardCache.get(db);
    if (cached && now - cached.at < LEADERBOARD_CACHE_TTL_MS) {
      return cached.entries.map((e) => ({ ...e }));
    }
  }
  const generation = boardGeneration.get(db) ?? 0;
  await ensureLeaderboardMigrated(db);
  const rows = await db.findByPrefix<GachaLeaderboardEntry>(LB_PREFIX);
  const byUid: Record<string, GachaLeaderboardEntry> = {};
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value !== "object" || !value.stats) continue;
    const uid = value.uid || row.id.slice(LB_PREFIX.length);
    byUid[uid] = { ...value, uid };
  }
  const entries = Object.values(await deduplicateLeaderboardAliases(db, byUid));
  // A write that happened while we were reading makes this snapshot suspect: do not keep it.
  if ((boardGeneration.get(db) ?? 0) === generation) {
    boardCache.set(db, { at: now, entries });
  }
  return entries.map((e) => ({ ...e }));
}

export async function removeLeaderboardEntry(
  db: CustomDatabase,
  uid: string,
): Promise<void> {
  await db.delete(lbKey(uid));
  invalidateLeaderboardCache(db);
}

/**
 * Remember that this UID's owner was seen in this guild (drives the "this
 * server" scope). Never creates a row, and writes only when the list changes
 * (a view must stay write-free once the guild is known). Keeps the newest 50.
 */
export function noteLeaderboardGuild(
  db: CustomDatabase,
  uid: string,
  guildId: string | null | undefined,
): boolean {
  if (!uid || !guildId) return false;
  const guild = String(guildId);
  const changed = db.transaction((store) => {
    const row = store.get<GachaLeaderboardEntry>(lbKey(uid));
    if (!row) return false;
    const guilds = Array.isArray(row.guilds) ? row.guilds.map(String) : [];
    if (guilds.includes(guild)) return false;
    guilds.push(guild);
    store.set(lbKey(uid), {
      ...row,
      guilds: guilds.slice(-MAX_GUILDS_PER_ENTRY),
    });
    return true;
  });
  if (changed) invalidateLeaderboardCache(db);
  return changed;
}

// ---------------------------------------------------------------------------
// Writing one UID's row
// ---------------------------------------------------------------------------

export async function updateLeaderboard(
  db: CustomDatabase,
  uid: string,
  data: GachaLogData,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
) {
  if (!isLeaderboardEligibleUid(uid)) {
    await removeLeaderboardEntry(db, uid);
    return;
  }
  // The statistics may need to fetch pool metadata, so they are computed before
  // (and outside) the transaction.
  const stats = await getGachaStats(db, data);
  const metrics = computeLeaderboardMetrics(stats, data);
  const logUpdatedAt = Number(data.info?.updatedAt) || 0;

  const resolvedNickname =
    gameNickname && gameNickname !== uid
      ? gameNickname
      : data.info.nickname && data.info.nickname !== uid
        ? data.info.nickname
        : undefined;
  const poolNames: Record<string, string> = {};
  for (const rec of [...data.characterList, ...data.weaponList]) {
    if (rec.poolId && rec.poolName) poolNames[rec.poolId] = rec.poolName;
  }

  db.transaction((store) => {
    // Re-check inside the transaction: a concurrent clear/delete must never be undone.
    if (!hasKey(store, `GACHA_LOG_${uid}`)) {
      store.delete(lbKey(uid));
      return;
    }
    const prev = store.get<GachaLeaderboardEntry>(lbKey(uid));
    // A slower computation from an older log must not replace a newer one.
    if (prev && Number(prev.logUpdatedAt || 0) > logUpdatedAt) return;

    const now = Date.now();
    const entry: GachaLeaderboardEntry = {
      uid,
      nickname: resolvedNickname ?? (uid === "GUEST" ? "GUEST" : uid),
      displayName: displayName ?? prev?.displayName,
      gameNickname: resolvedNickname,
      avatarUrl: data.info.avatarUrl,
      lastUpdate: now,
      total: metrics.total,
      nonFreeTotal: metrics.nonFreeTotal,
      freeTotal: metrics.freeTotal,
      accountIndex: accountIndex ?? prev?.accountIndex,
      stats: metrics.stats,
      poolNames,
      guilds: Array.isArray(prev?.guilds) ? prev!.guilds : [],
      updatedAt: now,
      logUpdatedAt,
      metricsVersion: LEADERBOARD_METRICS_VERSION,
    };
    store.set(lbKey(uid), entry);

    // Shared pool-name dictionary: merged in the same transaction, written only when it grows.
    const names = store.get<Record<string, string>>("GACHA_POOL_NAMES") || {};
    let changed = false;
    for (const [id, name] of Object.entries(poolNames)) {
      if (names[id] !== name) {
        names[id] = name;
        changed = true;
      }
    }
    if (changed) store.set("GACHA_POOL_NAMES", names);
  });
  invalidateLeaderboardCache(db);
}

export interface LeaderboardMetrics {
  total: number;
  nonFreeTotal: number;
  freeTotal: number;
  stats: GachaLeaderboardEntry["stats"];
}

/** Six-star rate as the stats card shows it: non-free 6-stars over non-free pulls. */
export function sixStarRate(sixNonFree: number, nonFreeTotal: number): number {
  return nonFreeTotal > 0 ? sixNonFree / nonFreeTotal : 0;
}

/**
 * The one place that turns getGachaStats() output into leaderboard numbers.
 * `data` (raw lists) adds the per-poolId rows used by the sub-pool boards.
 */
export function computeLeaderboardMetrics(
  stats: any,
  data?: { characterList?: GachaRecord[]; weaponList?: GachaRecord[] },
): LeaderboardMetrics {
  const out: GachaLeaderboardEntry["stats"] = {};
  const num = (v: unknown) => Number(v || 0);
  // Non-free counts only: free (expedited) 6-stars must not inflate the rate.
  const sixOf = (s: any) => num(s?.sixStarPullCount ?? s?.sixStarCount);
  const fiveOf = (s: any) => num(s?.fiveStarPullCount ?? s?.fiveStarCount);

  const processGroup = (gId: string, s: any) => {
    if (!s) return;
    const total = num(s.nonFreeTotal);
    const six = sixOf(s);
    out[gId] = {
      total,
      sixStarCount: six,
      fiveStarCount: fiveOf(s),
      probability: sixStarRate(six, total),
    };
  };

  const charSummary = stats.char?.summary || {};
  const weaponSummary = stats.weapon?.summary || {};
  for (const gId of Object.keys(charSummary)) processGroup(gId, charSummary[gId]);
  for (const gId of Object.keys(weaponSummary))
    processGroup(gId, weaponSummary[gId]);
  processGroup("SpecialShared", charSummary["SpecialShared"]);
  processGroup("StandardShared", stats.char?.StandardShared);
  processGroup("WeaponShared", stats.weapon?.WeaponShared);

  const nonFreeTotal = num(stats.char?.nonFreeTotal) + num(stats.weapon?.nonFreeTotal);
  const freeTotal = num(stats.char?.freeTotal) + num(stats.weapon?.freeTotal);
  const total = num(stats.char?.total) + num(stats.weapon?.total);
  const groups = [...Object.values(charSummary), ...Object.values(weaponSummary)];
  const totalSix = groups.reduce((a: number, s) => a + sixOf(s), 0);
  const totalFive = groups.reduce((a: number, s) => a + fiveOf(s), 0);
  out["TOTAL"] = {
    total: nonFreeTotal,
    sixStarCount: totalSix,
    fiveStarCount: totalFive,
    probability: sixStarRate(totalSix, nonFreeTotal),
  };

  // Per-poolId rows from raw records (a pity group such as SpecialShared merges pools).
  const perPool = (list: GachaRecord[] | undefined) => {
    const grouped: Record<string, GachaRecord[]> = {};
    for (const rec of list || []) {
      if (!rec.poolId || !isGachaPull(rec)) continue;
      (grouped[rec.poolId] ||= []).push(rec);
    }
    for (const [pid, recs] of Object.entries(grouped)) {
      const nonFree = recs.filter((r) => !isPullFree(r));
      const six = nonFree.filter((r) => r.rarity >= 6).length;
      const five = nonFree.filter((r) => r.rarity >= 5 && r.rarity < 6).length;
      if (!out[pid] || out[pid].total === 0) {
        out[pid] = {
          total: nonFree.length,
          sixStarCount: six,
          fiveStarCount: five,
          probability: sixStarRate(six, nonFree.length),
        };
      }
    }
  };
  perPool(data?.characterList);
  perPool(data?.weaponList);

  return { total, nonFreeTotal, freeTotal, stats: out };
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

const refreshFailures = new Set<string>();

/**
 * Rows migrated from the old blob carry the old (free-inclusive) six-star
 * numbers. Recompute a few per call from their logs until none are left.
 * Returns how many rows were processed. Cheap when there is nothing to do.
 */
export async function refreshLegacyLeaderboardEntries(
  db: CustomDatabase,
  opts: { max?: number } = {},
): Promise<number> {
  const max = opts.max ?? 3;
  const stale = db
    .findFieldByPrefix(LB_PREFIX, "$.metricsVersion")
    .filter(
      (row) =>
        (Number(row.field) || 0) < LEADERBOARD_METRICS_VERSION &&
        !refreshFailures.has(row.id),
    )
    .slice(0, max);
  let done = 0;
  for (const row of stale) {
    const uid = row.id.slice(LB_PREFIX.length);
    try {
      const data = await db.get<GachaLogData>(`GACHA_LOG_${uid}`);
      if (data) await updateLeaderboard(db, uid, data);
      else await removeLeaderboardEntry(db, uid);
      done++;
    } catch (e) {
      refreshFailures.add(row.id);
      console.error(`[Leaderboard] Refresh failed for ${uid}:`, e);
    }
    await setImmediateTick();
  }
  return done;
}

/** Registers the leaderboard's startup work. Call once from the ready handler. */
export function startGachaStorageJobs(
  startup: {
    onPrimary(name: string, fn: () => void | Promise<void>): void;
    every(name: string, ms: number, fn: () => void | Promise<void>): void;
  },
  db: CustomDatabase,
): void {
  startup.onPrimary("gacha-leaderboard-migrate", async () => {
    await migrateLeaderboardBlob(db);
  });
  startup.every("gacha-leaderboard-refresh", 30_000, async () => {
    await refreshLegacyLeaderboardEntries(db, { max: 3 });
  });
  // hourly: delete stats-cache rows older than 30 days
  startGachaCacheJobs(startup, db);
}

/**
 * Maintenance: recompute every row from its log. Batched; never called from a
 * command. (The old code ran this inside an interaction when the board looked empty.)
 */
export async function syncExistingLogsToLeaderboard(db: CustomDatabase) {
  const logIds = db.findKeysByPrefix("GACHA_LOG_");

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
    await setImmediateTick();
  }
}

// ---------------------------------------------------------------------------
// Ranking and paging (pure)
// ---------------------------------------------------------------------------

/** Luck-type sorts need at least this many non-free pulls in the ranked category. */
export const MIN_PULLS_FOR_LUCK_RANK = 100;
export const LEADERBOARD_PAGE_SIZE = 10;

export type LeaderboardSort = "pulls" | "luck";
export type LeaderboardScope = "global" | "guild";
type LeaderboardStat = GachaLeaderboardEntry["stats"][string];

/** Whether a stat may appear on the board for this sort. Total-pull sorts have no minimum. */
export function isRankableStat(
  stat: LeaderboardStat | undefined,
  sortType: LeaderboardSort,
): boolean {
  if (!stat) return false;
  const total = Number(stat.total || 0);
  if (!(total > 0)) return false;
  return sortType === "pulls" || total >= MIN_PULLS_FOR_LUCK_RANK;
}

export interface RankedRow {
  entry: GachaLeaderboardEntry;
  stat: LeaderboardStat;
  /** 1-based position in the whole ranking (not in the page). */
  rank: number;
}

/**
 * Drops rows that are the same person seen twice (identical numbers, name and
 * avatar - e.g. a global/CN alias pair), keeping the first one seen.
 */
function dropIdenticalRows(
  entries: GachaLeaderboardEntry[],
  poolId: string,
): GachaLeaderboardEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const stat = e.stats?.[poolId];
    if (!stat) return true;
    const hash = `${stat.total}_${stat.sixStarCount}_${stat.fiveStarCount}_${e.nickname}_${e.displayName}_${e.avatarUrl}`;
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/**
 * The ranking for one category and sort. Deterministic: ties fall back to more
 * pulls, then to the UID, so a page never reshuffles between two clicks.
 */
export function rankLeaderboard(
  entries: GachaLeaderboardEntry[],
  poolId: string,
  sortType: LeaderboardSort,
): RankedRow[] {
  // Stable base order first, so the identical-row filter is input-order independent too.
  const base = [...entries].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const rows = dropIdenticalRows(base, poolId)
    .filter((e) => isRankableStat(e.stats?.[poolId], sortType))
    .map((entry) => ({ entry, stat: entry.stats[poolId] }));

  rows.sort((a, b) => {
    const byValue =
      sortType === "pulls"
        ? Number(b.stat.total) - Number(a.stat.total)
        : Number(b.stat.probability || 0) - Number(a.stat.probability || 0);
    if (byValue) return byValue;
    const byTotal = Number(b.stat.total) - Number(a.stat.total);
    if (byTotal) return byTotal;
    return a.entry.uid < b.entry.uid ? -1 : a.entry.uid > b.entry.uid ? 1 : 0;
  });
  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

export interface LeaderboardViewOptions {
  poolId: string;
  sortType: LeaderboardSort;
  scope?: LeaderboardScope;
  /** null/undefined in a DM: only the global scope exists there. */
  guildId?: string | null;
  page?: number;
  pageSize?: number;
  /** The invoker's game UIDs (every key form). */
  myUids?: string[];
}

export interface LeaderboardView {
  poolId: string;
  sortType: LeaderboardSort;
  /** The scope actually shown (a guild scope without a guild falls back to global). */
  scope: LeaderboardScope;
  page: number;
  pageCount: number;
  pageSize: number;
  rankedCount: number;
  rows: RankedRow[];
  /** The invoker's ranked rows. */
  myRows: RankedRow[];
  /** ... of which are not on the shown page. */
  myOutside: RankedRow[];
  /** The invoker has pulls here but not enough for the luck ranking. */
  myUnranked: Array<{ entry: GachaLeaderboardEntry; stat: LeaderboardStat }>;
  /** Page holding the invoker's best rank, or null. */
  myPage: number | null;
  /** Server scope selected but nobody on this server is listed yet. */
  scopeEmpty: boolean;
  totalPlayers: number;
  totalPulls: number;
  /** Fraction (0..1): non-free 6-stars over non-free pulls across the scoped entries. */
  avgRate: number;
}

export function buildLeaderboardView(
  entries: GachaLeaderboardEntry[],
  opts: LeaderboardViewOptions,
): LeaderboardView {
  const pageSize = Math.max(1, opts.pageSize ?? LEADERBOARD_PAGE_SIZE);
  const scope: LeaderboardScope =
    opts.scope === "guild" && opts.guildId ? "guild" : "global";
  const scoped =
    scope === "guild"
      ? entries.filter((e) => (e.guilds || []).includes(String(opts.guildId)))
      : entries;
  const mine = new Set(opts.myUids || []);

  const ranked = rankLeaderboard(scoped, opts.poolId, opts.sortType);
  const pageCount = Math.max(1, Math.ceil(ranked.length / pageSize));
  const page = Math.min(Math.max(0, Math.floor(opts.page ?? 0) || 0), pageCount - 1);
  const rows = ranked.slice(page * pageSize, (page + 1) * pageSize);
  const myRows = ranked.filter((r) => mine.has(r.entry.uid));
  const shown = new Set(rows.map((r) => r.rank));

  let totalPulls = 0;
  let totalSix = 0;
  for (const e of scoped) {
    totalPulls += Number(e.stats?.[opts.poolId]?.total || 0);
    totalSix += Number(e.stats?.[opts.poolId]?.sixStarCount || 0);
  }

  return {
    poolId: opts.poolId,
    sortType: opts.sortType,
    scope,
    page,
    pageCount,
    pageSize,
    rankedCount: ranked.length,
    rows,
    myRows,
    myOutside: myRows.filter((r) => !shown.has(r.rank)),
    myUnranked: scoped
      .filter(
        (e) =>
          mine.has(e.uid) &&
          Number(e.stats?.[opts.poolId]?.total || 0) > 0 &&
          !isRankableStat(e.stats[opts.poolId], opts.sortType),
      )
      .map((entry) => ({ entry, stat: entry.stats[opts.poolId] })),
    myPage: myRows.length ? Math.floor((myRows[0].rank - 1) / pageSize) : null,
    scopeEmpty: scope === "guild" && scoped.length === 0,
    totalPlayers: scoped.length,
    totalPulls,
    avgRate: sixStarRate(totalSix, totalPulls),
  };
}

// ---------------------------------------------------------------------------
// Component ids
// ---------------------------------------------------------------------------

export const LEADERBOARD_ACTIONS = [
  "lb_type",
  "lb_pool",
  "lb_subpool",
  "lb_sort",
  "lb_scope",
  "lb_page",
  "lb_me",
  "lb_close",
] as const;
export type LeaderboardAction = (typeof LEADERBOARD_ACTIONS)[number];

export interface LeaderboardState {
  poolId: string;
  sortType: LeaderboardSort;
  scope: LeaderboardScope;
  page: number;
}

export function leaderboardCustomId(
  action: LeaderboardAction,
  state: LeaderboardState,
): string {
  return `gacha:${action}:${state.poolId}:${state.sortType}:${state.scope}:${state.page}`;
}

/** Reads any leaderboard component id, including ones from messages that predate scope and page. */
export function parseLeaderboardCustomId(
  customId: string,
): (LeaderboardState & { action: LeaderboardAction }) | null {
  const parts = String(customId).split(":");
  if (parts[0] !== "gacha") return null;
  const action = parts[1] as LeaderboardAction;
  if (!LEADERBOARD_ACTIONS.includes(action)) return null;
  const page = Number(parts[5]);
  return {
    action,
    poolId: parts[2] || "TOTAL",
    sortType: parts[3] === "pulls" ? "pulls" : "luck",
    scope: parts[4] === "guild" ? "guild" : "global",
    page: Number.isInteger(page) && page > 0 ? page : 0,
  };
}
