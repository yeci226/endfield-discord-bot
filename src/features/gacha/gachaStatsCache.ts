import { ENGINE_VERSION } from "./gachaStatsEngine";
import { GachaLogData } from "./gachaTypes";

/** Cache rows live next to the log row they describe: GACHA_STATS.<logKey>. */
export const STATS_CACHE_PREFIX = "GACHA_STATS.";

/**
 * Stats that contain 6-star items whose featured status could not be resolved
 * are recomputed after this long, because the pool metadata that would resolve
 * them may have been fetched in the meantime.
 */
export const UNKNOWN_FEATURED_TTL_MS = 10 * 60 * 1000;

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

export interface CachedStatsEntry<S> {
  engine: number;
  token: string;
  computedAt: number;
  info: GachaLogData["info"];
  stats: S;
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

function hasUnknownFeatured(stats: any): boolean {
  return (
    Number(stats?.char?.unknownFeaturedCount || 0) +
      Number(stats?.weapon?.unknownFeaturedCount || 0) >
    0
  );
}

/** Pure: may this cache entry be served for the current log token? */
export function isStatsEntryUsable(
  entry: Partial<CachedStatsEntry<any>> | null | undefined,
  token: string,
  now: number,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.engine !== ENGINE_VERSION) return false;
  if (entry.token !== token) return false;
  if (!entry.stats || !entry.info) return false;
  if (
    hasUnknownFeatured(entry.stats) &&
    !(now - Number(entry.computedAt || 0) < UNKNOWN_FEATURED_TTL_MS)
  ) {
    return false;
  }
  return true;
}

/**
 * Stats for one gacha log row. A hit reads only the (small) cache row and a
 * SQL-computed version token; the big log row is neither read nor parsed.
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
  const rowToken = db.getRowToken(logKey, "$.info.updatedAt");

  if (!rowToken) {
    if (db.getRowToken(cacheKey)) await db.delete(cacheKey);
    return null;
  }
  const token = makeStatsToken(rowToken);

  const cached = await db.get<CachedStatsEntry<S>>(cacheKey);
  if (isStatsEntryUsable(cached, token, now)) {
    return { stats: cached!.stats, info: cached!.info, hit: true };
  }

  const data = await db.get<GachaLogData>(logKey);
  if (!data) return null;
  const stats = await compute(data);
  const entry: CachedStatsEntry<S> = {
    engine: ENGINE_VERSION,
    token,
    computedAt: now,
    info: data.info,
    stats,
  };
  try {
    await db.set(cacheKey, entry);
  } catch (e) {
    // The cache is an optimisation: never fail a view because it could not be saved.
    console.error(`[GachaStatsCache] could not store ${cacheKey}:`, e);
  }
  return { stats, info: data.info, hit: false };
}
