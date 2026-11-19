import { promisify } from "util";
import zlib from "zlib";
import { ENGINE_VERSION } from "./gachaStatsEngine";
import { GachaLogData } from "./gachaTypes";

const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/** Cache rows live next to the log row they describe: GACHA_STATS.<logKey>. */
export const STATS_CACHE_PREFIX = "GACHA_STATS.";

/**
 * Stats that contain 6-star items whose featured status could not be resolved
 * are recomputed after this long, because the pool metadata that would resolve
 * them may have been fetched in the meantime.
 */
export const UNKNOWN_FEATURED_TTL_MS = 10 * 60 * 1000;

/**
 * Brotli quality for the payload. Measured on the 9,000-pull bench log: quality 2
 * is both smaller (219 KB) and about as fast as gzip level 1 (338 KB).
 */
export const STATS_BROTLI_QUALITY = 2;
/** Marks a row whose `payload` is base64(brotli(JSON({ info, stats }))). */
export const STATS_ROW_FORMAT = "br2";

/** Cache rows whose computedAt is older than this are deleted by the retention job. */
export const STATS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The only database operations the cache needs (lets tests count them). */
export interface StatsCacheDb {
  get<T = any>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  getRowToken(
    key: string,
    jsonPath?: string,
  ): { length: number; field: string | null } | null;
}

/**
 * A stored cache row. Everything needed to decide validity (and to find stale
 * rows with SQL json_extract) sits OUTSIDE the compressed payload, and comes
 * first in the serialized text.
 */
export interface CachedStatsRow {
  engine: number;
  token: string;
  computedAt: number;
  /** Count of 6-star items with an unresolved featured status (drives the short TTL). */
  unknown: number;
  format: typeof STATS_ROW_FORMAT;
  payload: string;
}

export interface CachedStatsResult<S> {
  stats: S;
  /** The log's `info` block, enough to draw the card without the log itself. */
  info: GachaLogData["info"];
  hit: boolean;
}

/**
 * Version token of a log row: its stored length plus info.updatedAt when the
 * row has one. Rows written before updatedAt existed rely on the length alone,
 * which changes whenever records are added.
 */
export function makeStatsToken(t: {
  length: number;
  field: string | null;
}): string {
  return `${t.length}:${t.field ?? ""}`;
}

function unknownFeaturedCount(stats: any): number {
  return (
    Number(stats?.char?.unknownFeaturedCount || 0) +
    Number(stats?.weapon?.unknownFeaturedCount || 0)
  );
}

/** Pure: may this cache row be served for the current log token? Rows in the old uncompressed shape never are. */
export function isStatsEntryUsable(
  entry: Partial<CachedStatsRow> | null | undefined,
  token: string,
  now: number,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.engine !== ENGINE_VERSION) return false;
  if (entry.token !== token) return false;
  if (entry.format !== STATS_ROW_FORMAT || typeof entry.payload !== "string") {
    return false;
  }
  return !isExpiredUnknown(entry.unknown, entry.computedAt, now);
}

function isExpiredUnknown(
  unknown: number | undefined,
  computedAt: number | undefined,
  now: number,
): boolean {
  return (
    Number(unknown || 0) > 0 &&
    !(now - Number(computedAt || 0) < UNKNOWN_FEATURED_TTL_MS)
  );
}

// ---------------------------------------------------------------------------
// Payload codec
// ---------------------------------------------------------------------------

export async function encodeStatsPayload(
  info: GachaLogData["info"],
  stats: unknown,
): Promise<{ payload: string; jsonLength: number }> {
  const json = JSON.stringify({ info, stats });
  const packed = await brotliCompressAsync(json, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: STATS_BROTLI_QUALITY },
  });
  return { payload: packed.toString("base64"), jsonLength: json.length };
}

export async function decodeStatsPayload<S>(
  payload: string,
): Promise<{ info: GachaLogData["info"]; stats: S; jsonLength: number }> {
  const json = (
    await brotliDecompressAsync(Buffer.from(payload, "base64"))
  ).toString("utf8");
  const parsed = JSON.parse(json) as { info: GachaLogData["info"]; stats: S };
  return { info: parsed.info, stats: parsed.stats, jsonLength: json.length };
}

// ---------------------------------------------------------------------------
// In-process LRU
// ---------------------------------------------------------------------------

export const STATS_MEMORY_MAX_ENTRIES = 24;
/** Estimated heap bytes, not JSON bytes: parsed objects take a few times the text. */
export const STATS_MEMORY_MAX_BYTES = 200 * 1024 * 1024;
export const STATS_MEMORY_TTL_MS = 15 * 60 * 1000;
/** Heap estimate = serialized JSON length x this. */
export const STATS_HEAP_FACTOR = 3;

interface MemoryEntry {
  stats: unknown;
  info: GachaLogData["info"];
  at: number;
  bytes: number;
  computedAt: number;
  unknown: number;
}

/**
 * Bounded LRU of computed stats, keyed by logKey + token + engine so a changed
 * log (new token) or a new engine version can never be answered from here.
 * Insertion order of the Map is the recency order. Values handed out are
 * shared between callers and frozen at the top level.
 */
export class StatsMemoryCache {
  private map = new Map<string, MemoryEntry>();
  private totalBytes = 0;
  constructor(
    public maxEntries = STATS_MEMORY_MAX_ENTRIES,
    public maxBytes = STATS_MEMORY_MAX_BYTES,
    public ttlMs = STATS_MEMORY_TTL_MS,
  ) {}

  static key(logKey: string, token: string, engine: number = ENGINE_VERSION) {
    return `${logKey}\u0000${token}\u0000${engine}`;
  }

  get size() {
    return this.map.size;
  }
  get bytes() {
    return this.totalBytes;
  }

  get(key: string, now: number): MemoryEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.remove(key);
      return undefined;
    }
    // refresh recency (TTL still counts from insertion)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(
    key: string,
    value: Omit<MemoryEntry, "at"> & { at?: number },
    now: number,
  ): void {
    this.remove(key);
    const entry: MemoryEntry = { ...value, at: value.at ?? now };
    this.map.set(key, entry);
    this.totalBytes += entry.bytes;
    // expired first, then least recently used, until both caps hold; a single
    // entry larger than the byte cap is kept alone rather than never cached.
    for (const [k, e] of this.map) {
      if (now - e.at >= this.ttlMs && k !== key) this.remove(k);
    }
    while (
      this.map.size > 1 &&
      (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes)
    ) {
      this.remove(this.map.keys().next().value as string);
    }
  }

  /** Drops every entry of one log (its row was deleted). */
  removeLog(logKey: string): void {
    const prefix = `${logKey}\u0000`;
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith(prefix)) this.remove(k);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  private remove(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    this.totalBytes -= e.bytes;
    this.map.delete(key);
  }
}

/** One LRU per database object (in production: one per process). */
const memoryByDb = new WeakMap<object, StatsMemoryCache>();
export function statsMemoryFor(db: object): StatsMemoryCache {
  let m = memoryByDb.get(db);
  if (!m) {
    m = new StatsMemoryCache();
    memoryByDb.set(db, m);
  }
  return m;
}

function freezeTop<T>(value: T): T {
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Stats for one gacha log row. A hit reads only a SQL-computed version token;
 * the big log row is neither read nor parsed. With the in-process LRU warm,
 * not even the cache row is read. The stats object handed out is shared with
 * other callers and frozen at the top level: treat it as read-only.
 * Returns null when the log row does not exist (its cache row is removed).
 *
 * The token is read BEFORE the log, so a log that changes while we compute
 * leaves a token that no longer matches and the next view recomputes.
 */
export async function getCachedGachaStats<S>(
  db: StatsCacheDb,
  logKey: string,
  compute: (data: GachaLogData) => Promise<S>,
  now: number = Date.now(),
): Promise<CachedStatsResult<S> | null> {
  const cacheKey = STATS_CACHE_PREFIX + logKey;
  const memory = statsMemoryFor(db);
  const rowToken = db.getRowToken(logKey, "$.info.updatedAt");

  if (!rowToken) {
    memory.removeLog(logKey);
    if (db.getRowToken(cacheKey)) await db.delete(cacheKey);
    return null;
  }
  const token = makeStatsToken(rowToken);
  const memKey = StatsMemoryCache.key(logKey, token);

  const inMemory = memory.get(memKey, now);
  if (inMemory && !isExpiredUnknown(inMemory.unknown, inMemory.computedAt, now)) {
    return {
      stats: inMemory.stats as S,
      info: inMemory.info,
      hit: true,
    };
  }

  const cached = await db.get<CachedStatsRow>(cacheKey);
  if (isStatsEntryUsable(cached, token, now)) {
    try {
      const decoded = await decodeStatsPayload<S>(cached!.payload);
      const stats = freezeTop(decoded.stats);
      const info = freezeTop(decoded.info);
      memory.set(
        memKey,
        {
          stats,
          info,
          bytes: decoded.jsonLength * STATS_HEAP_FACTOR,
          computedAt: cached!.computedAt,
          unknown: cached!.unknown,
        },
        now,
      );
      return { stats, info, hit: true };
    } catch (e) {
      // A corrupt payload is just a miss; the row is overwritten below.
      console.error(`[GachaStatsCache] unreadable ${cacheKey}:`, e);
    }
  }

  const data = await db.get<GachaLogData>(logKey);
  if (!data) return null;
  const computed = await compute(data);
  const stats = freezeTop(computed);
  const info = freezeTop(data.info);
  let jsonLength = 0;
  try {
    const { payload, jsonLength: len } = await encodeStatsPayload(info, stats);
    jsonLength = len;
    const row: CachedStatsRow = {
      engine: ENGINE_VERSION,
      token,
      computedAt: now,
      unknown: unknownFeaturedCount(stats),
      format: STATS_ROW_FORMAT,
      payload,
    };
    await db.set(cacheKey, row);
  } catch (e) {
    // The cache is an optimisation: never fail a view because it could not be saved.
    console.error(`[GachaStatsCache] could not store ${cacheKey}:`, e);
  }
  if (jsonLength > 0) {
    memory.set(
      memKey,
      {
        stats,
        info,
        bytes: jsonLength * STATS_HEAP_FACTOR,
        computedAt: now,
        unknown: unknownFeaturedCount(stats),
      },
      now,
    );
  }
  return { stats, info, hit: false };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface StatsRetentionDb {
  scanFieldsByPrefix(
    prefix: string,
    jsonPaths: string[],
    afterId: string | null,
    limit: number,
  ): Array<{ id: string; fields: Array<unknown> }>;
  deleteIds(ids: string[]): number;
}

/** Pure: is a cache row (by its computedAt header field) old enough to delete? A row without one is old-shape: expired. */
export function isStatsRowStale(
  computedAt: unknown,
  now: number,
  maxAgeMs: number = STATS_CACHE_MAX_AGE_MS,
): boolean {
  const t = Number(computedAt);
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t > maxAgeMs;
}

/** Position of the retention sweep inside the table, so each run continues where the last stopped. */
const sweepCursor = new WeakMap<object, string | null>();

/**
 * Deletes cache rows whose computedAt is older than 30 days: at most
 * `maxDeletes` per run, looking only at the header field via SQL (rows are not
 * parsed in JS), `scanBatch` rows at a time with a yield in between and at most
 * `maxScan` rows looked at per run. The next run continues after the last row
 * examined (wrapping around), so a large table is covered over several runs.
 */
export async function deleteStaleStatsCache(
  db: StatsRetentionDb,
  opts: {
    now?: number;
    maxDeletes?: number;
    scanBatch?: number;
    maxScan?: number;
    maxAgeMs?: number;
  } = {},
): Promise<{ scanned: number; deleted: number }> {
  const now = opts.now ?? Date.now();
  const maxDeletes = opts.maxDeletes ?? 500;
  const scanBatch = opts.scanBatch ?? 100;
  const maxScan = opts.maxScan ?? 1000;
  let after = sweepCursor.get(db) ?? null;
  let scanned = 0;
  let deleted = 0;
  let wrapped = false;
  while (scanned < maxScan && deleted < maxDeletes) {
    const rows = db.scanFieldsByPrefix(
      STATS_CACHE_PREFIX,
      ["$.computedAt"],
      after,
      scanBatch,
    );
    if (rows.length === 0) {
      if (after === null || wrapped) {
        after = null;
        break;
      }
      after = null; // wrap to the start once
      wrapped = true;
      continue;
    }
    scanned += rows.length;
    after = rows[rows.length - 1].id;
    const stale = rows
      .filter((r) => isStatsRowStale(r.fields[0], now, opts.maxAgeMs))
      .map((r) => r.id)
      .slice(0, maxDeletes - deleted);
    if (stale.length) deleted += db.deleteIds(stale);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  sweepCursor.set(db, after);
  return { scanned, deleted };
}

/** Registers the cache's periodic jobs. Called from startGachaStorageJobs. */
export function startGachaCacheJobs(
  startup: {
    every(name: string, ms: number, fn: () => void | Promise<void>): void;
  },
  db: StatsRetentionDb,
): void {
  startup.every("gacha-stats-cache-retention", 60 * 60 * 1000, async () => {
    await deleteStaleStatsCache(db);
  });
}
