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

function getBindingRoles(entry: any, gameId: number): any[] {
  const nestedRoles = Array.isArray(entry?.roles)
    ? entry.roles.filter(Boolean)
    : [];

  if (nestedRoles.length > 0) return nestedRoles;
  if (entry?.defaultRole) return [entry.defaultRole];

  if (entry?.uid || entry?.nickName) {
    return [
      {
        roleId: String(entry?.uid || ""),
        serverId: String(entry?.channelMasterId || ""),
        nickname: String(
          entry?.nickName ||
            entry?.uid ||
            (gameId === 3 ? "Endfield" : "Arknights"),
        ),
        level: 0,
        serverName: String(entry?.channelName || entry?.gameName || "-"),
      },
    ];
  }

  return [];
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

    const roles = getBindingRoles(entry, gameId);
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
