import fs from "fs";
import path from "path";

export const ASSETS_ROOT = path.join(__dirname, "../assets");

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const PREFIXES = ["/endfield/assets/", "/assets/"];

/**
 * Templates saved by the editor hold absolute links to the bot's own static
 * assets (https://<editor host>/assets/weapon/x.png). If `url` is such a link
 * and the file exists inside our assets folder, returns its path relative to
 * that folder (forward slashes); otherwise null.
 *
 * The host is ignored on purpose: the editor's public domain has changed, and
 * stored templates keep whichever domain they were saved under. Only files
 * that really exist under the assets folder ever match, so this cannot be
 * used to reach anything else.
 */
export function resolveOwnAssetRel(
  url: string,
  assetsRoot: string = ASSETS_ROOT,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const prefix = PREFIXES.find((p) => pathname.startsWith(p));
  if (!prefix) return null;

  const rel = pathname.slice(prefix.length);
  if (
    !rel ||
    rel.includes("..") ||
    rel.includes("\\") ||
    rel.includes("\0") ||
    rel.startsWith("/") ||
    !IMAGE_EXT.test(rel)
  ) {
    return null;
  }
  // downloaded files are not "our" assets
  if (rel.startsWith("cache/") || rel.startsWith("remote_cache/")) return null;

  const root = path.resolve(assetsRoot);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return rel;
}
