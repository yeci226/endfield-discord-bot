export interface RateLimiterOptions {
  /** Maximum number of allowed hits inside any window. */
  limit: number;
  windowMs: number;
  /** Upper bound of tracked keys; idle keys are evicted first, then the oldest. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed; otherwise how long until the oldest hit leaves the window. */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
  /** Number of keys currently tracked. */
  size(): number;
}

/**
 * In-memory sliding-window limiter. Rejected attempts are not recorded, so a
 * user who keeps hammering is released one window after their last allowed hit.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  function evict(now: number): void {
    for (const [key, list] of hits) {
      if (list.length === 0 || list[list.length - 1] <= now - windowMs)
        hits.delete(key);
    }
    // Still full of active keys: drop the oldest-inserted ones.
    while (hits.size >= maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    check(key, now = Date.now()) {
      let list = hits.get(key);
      if (list) {
        const cutoff = now - windowMs;
        let drop = 0;
        while (drop < list.length && list[drop] <= cutoff) drop++;
        if (drop) list.splice(0, drop);
      } else {
        if (hits.size >= maxKeys) evict(now);
        list = [];
        hits.set(key, list);
      }
      if (list.length >= limit) {
        return { allowed: false, retryAfterMs: list[0] + windowMs - now };
      }
      list.push(now);
      return { allowed: true, retryAfterMs: 0 };
    },
    size: () => hits.size,
  };
}
