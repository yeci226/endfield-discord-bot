import { validateProxyUrl } from "./imageProxy";

/** Keys whose string value the renderer may load as an image. */
const IMAGE_KEYS = new Set([
  "src",
  "url",
  "avatarUrl",
  "bgUrl",
  "backgroundUrl",
  "iconUrl",
  "imageUrl",
]);
const MAX_DEPTH = 24;
const PROXY_MARK = "/api/proxy?url=";

export type TemplateCheck = { ok: true } | { ok: false; reason: string };

function checkImageRef(v: string): string | null {
  const proxyAt = v.indexOf(PROXY_MARK);
  if (proxyAt !== -1) {
    // The renderer re-fetches the inner URL of a proxy link
    let inner: string;
    try {
      inner = decodeURIComponent(v.split("url=")[1] ?? "");
    } catch {
      return "bad proxy url";
    }
    const c = validateProxyUrl(inner);
    return c.ok ? null : `image url refused (${c.reason})`;
  }
  if (/^https?:\/\//i.test(v)) {
    const c = validateProxyUrl(v);
    return c.ok ? null : `image url refused (${c.reason})`;
  }
  if (/^data:image\//i.test(v)) return null; // never touches network or disk
  // local asset path: must stay inside the assets folder
  if (
    v.includes("..") ||
    v.includes("\\") ||
    v.includes("\0") ||
    v.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(v)
  ) {
    return "image path refused";
  }
  return null;
}

function walk(node: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return "template too deeply nested";
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walk(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (IMAGE_KEYS.has(k) && v) {
          const r = checkImageRef(v);
          if (r) return r;
        }
        // fabricJson is stored as a JSON string
        if (k === "fabricJson" && v.startsWith("{")) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(v);
          } catch {
            return "bad fabricJson";
          }
          const r = walk(parsed, depth + 1);
          if (r) return r;
        }
      } else {
        const r = walk(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Rejects templates whose image references would make the server fetch a
 * non-allow-listed URL or read a file outside assets (the renderer loads
 * these when drawing the profile card).
 */
export function validateTemplateImages(template: unknown): TemplateCheck {
  const reason = walk(template, 0);
  return reason ? { ok: false, reason } : { ok: true };
}
