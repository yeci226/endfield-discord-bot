import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";

/** Hosts (exact or any subdomain) the image proxy may fetch from. */
export const ALLOWED_PROXY_HOSTS = [
  "skport.com",
  "gryphline.com",
  "hypergryph.com",
  "hycdn.cn",
  "discordapp.com",
  "discordapp.net",
];

export const PROXY_TIMEOUT_MS = 8_000;
export const PROXY_MAX_BYTES = 8 * 1024 * 1024;
export const PROXY_MAX_REDIRECTS = 3;
export const CACHE_MAX_BYTES = 300 * 1024 * 1024;
export const CACHE_MAX_FILES = 5000;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};
export const CACHE_EXTENSIONS = [...new Set(Object.values(EXT_BY_TYPE))];

export type ProxyUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export function validateProxyUrl(input: unknown): ProxyUrlCheck {
  if (typeof input !== "string" || !input) {
    return { ok: false, reason: "missing url" };
  }
  if (input.length > 2048) return { ok: false, reason: "url too long" };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "https only" };
  if (url.username || url.password)
    return { ok: false, reason: "credentials not allowed" };
  if (url.port && url.port !== "443")
    return { ok: false, reason: "port not allowed" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || net.isIP(host) !== 0)
    return { ok: false, reason: "ip literal not allowed" };
  const allowed = ALLOWED_PROXY_HOSTS.some(
    (h) => host === h || host.endsWith("." + h),
  );
  if (!allowed) return { ok: false, reason: "host not allowed" };
  return { ok: true, url };
}

/** File extension for a response content-type, or null when it must be refused (svg, html, ...). */
export function extensionForContentType(ct: unknown): string | null {
  if (typeof ct !== "string") return null;
  const type = ct.split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/") || type === "image/svg+xml") return null;
  return EXT_BY_TYPE[type] ?? null;
}

/** Files under assets/cache that may be served statically (images only). */
export function isServableCacheFile(filePath: string): boolean {
  return CACHE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function cacheKey(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

export interface RawResponse {
  status: number;
  headers: Record<string, any>;
  body: AsyncIterable<Buffer | Uint8Array>;
  /** Called to abort the underlying transfer. */
  abort(): void;
}
export type RawRequest = (
  url: URL,
  signal: AbortSignal,
) => Promise<RawResponse>;

export const axiosRequest: RawRequest = async (url, signal) => {
  const res = await axios.get(url.toString(), {
    responseType: "stream",
    maxRedirects: 0,
    timeout: PROXY_TIMEOUT_MS,
    signal,
    validateStatus: () => true,
    headers: { Accept: "image/*" },
  });
  return {
    status: res.status,
    headers: res.headers as any,
    body: res.data,
    abort: () => res.data?.destroy?.(),
  };
};

export class ProxyError extends Error {
  constructor(
    public reason: string,
    public status = 502,
  ) {
    super(reason);
  }
}

export interface FetchedImage {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

/**
 * Fetches an allow-listed image: HTTPS only, at most 3 redirects (allow-list
 * re-checked on every hop), 8 s overall, 8 MB cap, image/* (not svg) only.
 */
export async function fetchProxiedImage(
  input: string,
  request: RawRequest = axiosRequest,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedImage> {
  const timeoutMs = limits.timeoutMs ?? PROXY_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? PROXY_MAX_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let check = validateProxyUrl(input);
    for (let hop = 0; ; hop++) {
      if (!check.ok) throw new ProxyError(check.reason, 400);
      let res: RawResponse;
      try {
        res = await request(check.url, ac.signal);
      } catch (e: any) {
        if (e instanceof ProxyError) throw e;
        throw new ProxyError(ac.signal.aborted ? "timeout" : "request failed");
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.abort();
        if (hop >= PROXY_MAX_REDIRECTS)
          throw new ProxyError("too many redirects");
        let next: string;
        try {
          next = new URL(String(res.headers.location), check.url).toString();
        } catch {
          throw new ProxyError("bad redirect");
        }
        check = validateProxyUrl(next);
        continue;
      }
      if (res.status !== 200) {
        res.abort();
        throw new ProxyError(`upstream status ${res.status}`);
      }
      const contentType = String(res.headers["content-type"] ?? "");
      const ext = extensionForContentType(contentType);
      if (!ext) {
        res.abort();
        throw new ProxyError("unsupported content type", 415);
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.abort();
        throw new ProxyError("too large", 413);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > maxBytes) {
            res.abort();
            throw new ProxyError("too large", 413);
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (e: any) {
        if (e instanceof ProxyError) throw e;
        throw new ProxyError(ac.signal.aborted ? "timeout" : "stream failed");
      }
      return {
        buffer: Buffer.concat(chunks),
        contentType: contentType.split(";")[0].trim().toLowerCase(),
        ext,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Looks for a cached copy of `url`; returns its path or null. */
export function findCached(cacheDir: string, url: string): string | null {
  const key = cacheKey(url);
  for (const ext of CACHE_EXTENSIONS) {
    const p = path.join(cacheDir, key + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Writes atomically (temp file + rename). */
export async function writeCached(
  cacheDir: string,
  url: string,
  img: FetchedImage,
): Promise<string> {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const final = path.join(cacheDir, cacheKey(url) + img.ext);
  const tmp = `${final}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, img.buffer);
  await fs.promises.rename(tmp, final);
  return final;
}

/**
 * Keeps the cache under maxBytes / maxFiles by deleting the oldest files (by
 * mtime). Files that are not cache images (legacy .html/.svg, stray temp
 * files) are always deleted. Returns the number of deleted files.
 */
export function evictCache(
  cacheDir: string,
  limits: { maxBytes?: number; maxFiles?: number } = {},
): number {
  const maxBytes = limits.maxBytes ?? CACHE_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? CACHE_MAX_FILES;
  if (!fs.existsSync(cacheDir)) return 0;
  let deleted = 0;
  const keep: { p: string; size: number; mtime: number }[] = [];
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const p = path.join(cacheDir, entry.name);
    try {
      const st = fs.statSync(p);
      if (!isServableCacheFile(p)) {
        // skip very fresh files: could be an in-flight temp write
        if (Date.now() - st.mtimeMs > 5 * 60_000) {
          fs.unlinkSync(p);
          deleted++;
        }
      } else keep.push({ p, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  keep.sort((a, b) => a.mtime - b.mtime);
  let bytes = keep.reduce((n, f) => n + f.size, 0);
  let count = keep.length;
  for (const f of keep) {
    if (bytes <= maxBytes && count <= maxFiles) break;
    try {
      fs.unlinkSync(f.p);
      deleted++;
    } catch {}
    bytes -= f.size;
    count--;
  }
  return deleted;
}
