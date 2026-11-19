import type { Image } from "@napi-rs/canvas";

export interface ByteLruOptions<V> {
  maxEntries: number;
  maxBytes: number;
  /** Entries older than this are dropped on access. Omit for no expiry. */
  ttlMs?: number;
  sizeOf: (value: V) => number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  bytes: number;
  expiresAt: number;
}

/**
 * Least-recently-used map bounded by entry count AND by estimated bytes.
 * `get` refreshes recency; `set` evicts from the cold end until both caps hold.
 * A single value larger than `maxBytes` is never stored.
 */
export class ByteLruCache<K, V> {
  /** When false, `get` always misses and `set` stores nothing (bench / bypass). */
  enabled = true;
  private map = new Map<K, Entry<V>>();
  private totalBytes = 0;
  private readonly now: () => number;

  constructor(private readonly opts: ByteLruOptions<V>) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: K): V | undefined {
    if (!this.enabled) return undefined;
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (!this.enabled) return;
    this.delete(key);
    const bytes = Math.max(0, Math.floor(this.opts.sizeOf(value)));
    if (bytes > this.opts.maxBytes) return;
    this.map.set(key, {
      value,
      bytes,
      expiresAt: this.opts.ttlMs ? this.now() + this.opts.ttlMs : Infinity,
    });
    this.totalBytes += bytes;
    while (
      this.map.size > this.opts.maxEntries ||
      this.totalBytes > this.opts.maxBytes
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.totalBytes -= e.bytes;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return Array.from(this.map.keys());
  }
}

/** Cap for all decoded images held by the renderer, in bytes (width*height*4). */
export const DECODED_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const DECODED_IMAGE_CACHE_MAX_ENTRIES = 600;
export const DECODED_IMAGE_CACHE_TTL_MS = 60 * 60_000;

export function estimateImageBytes(img: { width: number; height: number }): number {
  return Math.max(1, (img.width || 0) * (img.height || 0) * 4);
}

/** One process-wide cache shared by canvasUtils, the gacha icon loader and backgrounds. */
export const decodedImageCache = new ByteLruCache<string, Image>({
  maxEntries: DECODED_IMAGE_CACHE_MAX_ENTRIES,
  maxBytes: DECODED_IMAGE_CACHE_MAX_BYTES,
  ttlMs: DECODED_IMAGE_CACHE_TTL_MS,
  sizeOf: estimateImageBytes,
});
