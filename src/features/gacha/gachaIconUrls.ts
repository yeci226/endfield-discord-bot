import { validateRendererImageUrl } from "../../utils/canvasUtils";

/** Row holding `{ "<operator or weapon id>": "<icon url>" }`, learned from the wiki pool lists. */
export const GACHA_ICON_URLS_KEY = "GACHA_ICON_URLS";

const MAX_URL_LENGTH = 512;

/** What the store needs from the database (lets tests count writes). */
export interface IconUrlDb {
  get<T = any>(key: string): Promise<T | null>;
  update<T = any>(
    key: string,
    fn: (current: T | null) => T | null,
  ): T | null;
}

/**
 * The skport wiki pool lists (`/web/v1/wiki/char-pool` and `/weapon-pool`)
 * give, per banner, `chars[]` / `weapons[]` of `{ name, pic }` and nothing
 * else: no ids. The id therefore comes from the picture's own file name, the
 * same way gachaSimulatorUtils reads it for featured characters
 * (`icon_chr_...`). A picture whose URL carries no id is skipped, never guessed.
 */
export function iconIdFromPic(
  kind: "character" | "weapon",
  pic: unknown,
): string | null {
  const text = String(pic ?? "");
  const match =
    kind === "character"
      ? /icon_(chr_\w+)/i.exec(text)
      : /(wpn_[a-z]+_\d+)/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** Pure: id -> url for every usable picture of the given pool lists. Only hosts the renderer allows. */
export function extractPoolIconUrls(
  charPools: ReadonlyArray<{ chars?: ReadonlyArray<{ pic?: string }> }> | undefined,
  weaponPools: ReadonlyArray<{ weapons?: ReadonlyArray<{ pic?: string }> }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (kind: "character" | "weapon", pic: unknown) => {
    if (typeof pic !== "string" || pic.length > MAX_URL_LENGTH) return;
    const id = iconIdFromPic(kind, pic);
    if (!id || out[id] !== undefined) return;
    if (!validateRendererImageUrl(pic).ok) return;
    out[id] = pic;
  };
  for (const pool of charPools ?? [])
    for (const c of pool?.chars ?? []) take("character", c?.pic);
  for (const pool of weaponPools ?? [])
    for (const w of pool?.weapons ?? []) take("weapon", w?.pic);
  return out;
}

/** Pure: the ids in `found` that `current` does not have yet. */
export function newIconUrls(
  current: Record<string, string> | null | undefined,
  found: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, url] of Object.entries(found)) {
    if (!current || current[id] === undefined) out[id] = url;
  }
  return out;
}

/**
 * Merges newly learned icon URLs into the shared row. Writes only when there is
 * at least one id the row does not have (existing ids are never rewritten, so a
 * wiki that rotates its URLs cannot cause a write per call). Returns how many
 * ids were added.
 */
export async function rememberIconUrls(
  db: IconUrlDb,
  found: Record<string, string>,
): Promise<number> {
  if (Object.keys(found).length === 0) return 0;
  const current = await db.get<Record<string, string>>(GACHA_ICON_URLS_KEY);
  if (Object.keys(newIconUrls(current, found)).length === 0) return 0;
  let added = 0;
  db.update<Record<string, string>>(GACHA_ICON_URLS_KEY, (row) => {
    const fresh = newIconUrls(row, found); // the row may have grown since the read
    added = Object.keys(fresh).length;
    return added === 0 ? row : { ...(row ?? {}), ...fresh };
  });
  return added;
}

/** Keeps only entries that still pass the renderer's host rules (the row is shared, so never trusted blindly). */
export function sanitizeStoredIconUrls(
  row: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!row || typeof row !== "object") return out;
  for (const [id, url] of Object.entries(row as Record<string, unknown>)) {
    if (
      typeof url === "string" &&
      url.length <= MAX_URL_LENGTH &&
      /^(chr|wpn)_\w+$/i.test(id) &&
      validateRendererImageUrl(url).ok
    ) {
      out[id.toLowerCase()] = url;
    }
  }
  return out;
}
