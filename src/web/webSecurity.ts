import crypto from "crypto";

/** Unguessable URL-safe token (192 bits). */
export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Cheap shape check done before touching the database. */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

/**
 * Replaces secrets in a request URL so it can be logged:
 * /api/profile/<token>, /api/preview/<token>, ?token=..., ?session=...
 */
export function maskTokensInUrl(url: string): string {
  return url
    .replace(/(\/api\/(?:profile|preview)\/)[^/?#]+/g, "$1:token")
    .replace(/([?&](?:token|session|sessionId)=)[^&#]*/g, "$1:token");
}

export interface RateLimiter {
  /** Records one hit for `key`. */
  check(
    key: string,
    now?: number,
  ): { allowed: boolean; retryAfterMs: number };
}

/**
 * In-memory sliding-window limiter: at most `limit` hits per `windowMs` per
 * key. Idle keys are dropped so the map cannot grow without bound.
 */
export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  const sweep = (now: number) => {
    for (const [key, list] of hits) {
      if (list.length === 0 || list[list.length - 1] <= now - windowMs)
        hits.delete(key);
    }
  };

  return {
    check(key, now = Date.now()) {
      if (hits.size >= maxKeys && !hits.has(key)) {
        sweep(now);
        // still full of active keys: drop the oldest-inserted one
        if (hits.size >= maxKeys) {
          const first = hits.keys().next().value;
          if (first !== undefined) hits.delete(first);
        }
      }
      const list = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return { allowed: false, retryAfterMs: list[0] + windowMs - now };
      }
      list.push(now);
      hits.set(key, list);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Client IP used as a rate-limit key. X-Forwarded-For is only trusted (first
 * hop) when the socket peer itself is loopback, i.e. the cloudflared tunnel.
 */
export function resolveClientIp(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  const socketIp = peer || "unknown";
  if (!LOOPBACK.has(socketIp)) return socketIp;
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = raw?.split(",")[0]?.trim();
  return first || socketIp;
}

/** Parses WEB_ALLOWED_ORIGINS (comma-separated). Empty = same-origin only. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** Entry stored in a BoundedCache. */
interface CacheEntry<V> {
  value: V;
  expires: number;
  /** Absolute time after which the owning edit token is invalid. */
  tokenExpiresAt: number;
}

/** Small TTL cache with a hard entry limit and token-expiry eviction. */
export class BoundedCache<V> {
  private map = new Map<string, CacheEntry<V>>();
  constructor(private maxEntries = 200) {}

  get(key: string, now = Date.now()): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= now || e.tokenExpiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(
    key: string,
    value: V,
    ttlMs: number,
    tokenExpiresAt: number,
    now = Date.now(),
  ) {
    this.map.delete(key);
    if (this.map.size >= this.maxEntries) this.prune(now);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: now + ttlMs, tokenExpiresAt });
  }

  prune(now = Date.now()) {
    for (const [k, e] of this.map) {
      if (e.expires <= now || e.tokenExpiresAt <= now) this.map.delete(k);
    }
  }

  get size() {
    return this.map.size;
  }
}
