import { drawGachaStats as drawGachaStatsImpl } from "../features/gacha/statsCanvas/drawGachaStats";

export * from "../features/gacha/iconLoader";
export * from "../features/gacha/statsCanvas/shared";

// Kept as a real function (not an `export *` getter) so tests and callers can
// still replace `drawGachaStats` on this module.
export function drawGachaStats(
  ...args: Parameters<typeof drawGachaStatsImpl>
): ReturnType<typeof drawGachaStatsImpl> {
  return drawGachaStatsImpl(...args);
}
