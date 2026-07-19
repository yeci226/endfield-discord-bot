import { normalizeBindingRoles } from "./bindingRoleUtils";

export type DailyGameScope = "endfield" | "arknights" | "both";

export interface AttendanceBinding {
  gameId: number;
  roles: any[];
}

const SUPPORTED_GAME_IDS = new Set([1, 3]);

export function isSupportedAttendanceGame(gameId: unknown): boolean {
  return SUPPORTED_GAME_IDS.has(Number(gameId));
}

function isGameInScope(gameId: number, scope: DailyGameScope): boolean {
  if (scope === "both") return gameId === 1 || gameId === 3;
  if (scope === "arknights") return gameId === 1;
  return gameId === 3;
}

export function normalizeAttendanceBindings(
  raw: any,
  scope: DailyGameScope,
): AttendanceBinding[] {
  const normalized: AttendanceBinding[] = [];

  const pushBinding = (entry: any) => {
    const gameId = Number(entry?.gameId || 0);
    if (!isSupportedAttendanceGame(gameId)) return;
    if (!isGameInScope(gameId, scope)) return;

    const roles = normalizeBindingRoles(entry);
    if (roles.length > 0) normalized.push({ gameId, roles });
  };

  if (!Array.isArray(raw)) return normalized;

  for (const item of raw) {
    if (Array.isArray(item?.bindingList)) {
      for (const binding of item.bindingList) pushBinding(binding);
      continue;
    }
    pushBinding(item);
  }

  return normalized;
}
