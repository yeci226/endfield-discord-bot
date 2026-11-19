import { drawGachaStats as drawGachaStatsImpl } from "../features/gacha/statsCanvas/drawGachaStats";
import {
  buildGachaCardKey,
  getOrRenderCard,
} from "../features/gacha/statsCanvas/cardCache";

export * from "../features/gacha/iconLoader";
export * from "../features/gacha/statsCanvas/shared";

// Kept as a real function (not an `export *` getter) so tests and callers can
// still replace `drawGachaStats` on this module.
//
// Cards are cached by a hash of everything that changes pixels (stats, view
// params, UI language, user fields) for a few minutes; a hit returns the same
// encoded buffer without touching canvas. The returned Buffer is shared, so
// callers must not modify it.
export function drawGachaStats(
  ...args: Parameters<typeof drawGachaStatsImpl>
): ReturnType<typeof drawGachaStatsImpl> {
  const [data, stats, tr, type = "limited_char", selectedPoolId, page = 0] =
    args;
  const lang = (tr as any)?.lang;
  if (!lang || !stats) return drawGachaStatsImpl(...args);
  let key: string;
  try {
    key = buildGachaCardKey({ data, stats, type, selectedPoolId, page, lang });
  } catch {
    return drawGachaStatsImpl(...args);
  }
  return getOrRenderCard(key, () => drawGachaStatsImpl(...args));
}
