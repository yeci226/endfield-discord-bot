import assert from "node:assert/strict";
import {
  ByteLruCache,
  DECODED_IMAGE_CACHE_MAX_BYTES,
  decodedImageCache,
  estimateImageBytes,
} from "./byteLruCache";

function main() {
  // Eviction order: least recently used goes first; get refreshes recency.
  const byCount = new ByteLruCache<string, number>({
    maxEntries: 3,
    maxBytes: 1000,
    sizeOf: () => 1,
  });
  byCount.set("a", 1);
  byCount.set("b", 2);
  byCount.set("c", 3);
  assert.equal(byCount.get("a"), 1); // a is now the newest
  byCount.set("d", 4);
  assert.deepEqual(byCount.keys(), ["c", "a", "d"]);
  assert.equal(byCount.get("b"), undefined);

  // Byte cap.
  const byBytes = new ByteLruCache<string, number>({
    maxEntries: 100,
    maxBytes: 100,
    sizeOf: (v) => v,
  });
  byBytes.set("x", 60);
  byBytes.set("y", 30);
  assert.equal(byBytes.bytes, 90);
  byBytes.set("z", 40); // 130 > 100 -> evict x
  assert.deepEqual(byBytes.keys(), ["y", "z"]);
  assert.equal(byBytes.bytes, 70);
  byBytes.set("huge", 101); // larger than the whole cap: never stored
  assert.equal(byBytes.get("huge"), undefined);
  assert.equal(byBytes.bytes, 70);
  byBytes.set("y", 10); // replacing re-counts bytes
  assert.equal(byBytes.bytes, 50);
  byBytes.delete("z");
  assert.equal(byBytes.bytes, 10);
  byBytes.clear();
  assert.equal(byBytes.bytes, 0);
  assert.equal(byBytes.size, 0);

  // TTL.
  let t = 1000;
  const ttl = new ByteLruCache<string, number>({
    maxEntries: 10,
    maxBytes: 100,
    ttlMs: 50,
    sizeOf: () => 1,
    now: () => t,
  });
  ttl.set("k", 1);
  t += 49;
  assert.equal(ttl.get("k"), 1);
  t += 2;
  assert.equal(ttl.get("k"), undefined);
  assert.equal(ttl.bytes, 0);

  // Disabled cache stores nothing.
  const off = new ByteLruCache<string, number>({
    maxEntries: 10,
    maxBytes: 100,
    sizeOf: () => 1,
  });
  off.enabled = false;
  off.set("a", 1);
  assert.equal(off.get("a"), undefined);
  off.enabled = true;
  assert.equal(off.size, 0);

  // Image sizing and the shared cache cap (256 MB).
  assert.equal(estimateImageBytes({ width: 100, height: 50 }), 20000);
  assert.equal(DECODED_IMAGE_CACHE_MAX_BYTES, 256 * 1024 * 1024);
  const big = { width: 8192, height: 8192 } as any; // 256 MB exactly
  decodedImageCache.set("big1", big);
  decodedImageCache.set("big2", { width: 8192, height: 8192 } as any);
  assert.ok(decodedImageCache.bytes <= DECODED_IMAGE_CACHE_MAX_BYTES);
  assert.equal(decodedImageCache.get("big1"), undefined);
  decodedImageCache.clear();
}

main();
