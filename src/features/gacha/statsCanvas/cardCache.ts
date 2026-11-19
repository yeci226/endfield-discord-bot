import crypto from "crypto";
import { ByteLruCache } from "../../../utils/byteLruCache";

export const CARD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const CARD_CACHE_MAX_ENTRIES = 200;
export const CARD_CACHE_TTL_MS = 10 * 60_000;

/** Encoded cards (webp buffers); never holds an empty buffer. */
export const renderedCardCache = new ByteLruCache<string, Buffer>({
  maxEntries: CARD_CACHE_MAX_ENTRIES,
  maxBytes: CARD_CACHE_MAX_BYTES,
  ttlMs: CARD_CACHE_TTL_MS,
  sizeOf: (b) => b.length,
});

const inFlight = new Map<string, Promise<Buffer>>();

/** JSON with object keys sorted, so equal data always serializes to equal text. */
export function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: any): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "undefined":
      case "function":
      case "symbol":
        return "undefined";
      case "number":
        return Number.isFinite(v) ? String(v) : `"${String(v)}"`;
      case "bigint":
        return `"${v}n"`;
      case "string":
      case "boolean":
        return JSON.stringify(v);
    }
    if (v instanceof Date) return `"d:${v.getTime()}"`;
    if (seen.has(v)) throw new Error("canonicalStringify: cyclic value");
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = "[" + v.map((x) => walk(x)).join(",") + "]";
    } else if (v instanceof Map) {
      out = walk(Array.from(v.entries()));
    } else if (v instanceof Set) {
      out = walk(Array.from(v.values()));
    } else {
      const parts: string[] = [];
      for (const k of Object.keys(v).sort()) {
        const s = walk(v[k]);
        if (s !== "undefined") parts.push(JSON.stringify(k) + ":" + s);
      }
      out = "{" + parts.join(",") + "}";
    }
    seen.delete(v);
    return out;
  };
  return walk(value);
}

export interface GachaCardKeyInput {
  data: { info?: any } | null | undefined;
  stats: unknown;
  type: unknown;
  selectedPoolId?: string;
  page: number;
  /** UI language of the translator (`tr.lang`). */
  lang: string;
  now?: number;
}

/**
 * sha1 over every input that changes pixels. The card only reads `data.info`
 * (the record lists are already summarised in `stats`). When the log has no
 * export timestamp the card prints the current time to the minute, so the
 * minute is part of the key then.
 */
export function buildGachaCardKey(input: GachaCardKeyInput): string {
  const info = input.data?.info ?? {};
  const clockMinute = info.export_timestamp
    ? null
    : Math.floor((input.now ?? Date.now()) / 60_000);
  const text = canonicalStringify({
    v: 1,
    info,
    stats: input.stats,
    type: input.type,
    poolId: input.selectedPoolId ?? null,
    page: input.page,
    lang: input.lang,
    clockMinute,
  });
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * Returns the stored buffer for `key`, or runs `render` once (concurrent
 * callers with the same key share one render) and stores a non-empty result.
 * The returned buffer is shared: callers must not mutate it.
 */
export async function getOrRenderCard(
  key: string,
  render: () => Promise<Buffer>,
): Promise<Buffer> {
  const hit = renderedCardCache.get(key);
  if (hit) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = render().then((buf) => {
    if (buf && buf.length > 0) renderedCardCache.set(key, buf);
    return buf;
  });
  if (!renderedCardCache.enabled) return job;
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}
