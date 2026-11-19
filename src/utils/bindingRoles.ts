/**
 * One place that turns SKPort "bindings" (what `account.roles` stores) into roles.
 *
 * Rules that keep existing users on the same role:
 *  - A binding that already has non-empty `roles` (or a `defaultRole`) returns exactly those
 *    roles; `raw` is the stored object, `roleId`/`serverId` are not rewritten.
 *  - A role is synthesized from the binding itself only when it has neither. For gameId 1
 *    the synthesized object is identical to what daily.ts / AutoDailyService.ts built before.
 *  - Callers always name the games they want; there is no "any game" synthesis.
 *
 * See docs/superpowers/notes/binding-roles-revert.md for why the earlier attempts were reverted.
 */

export const ENDFIELD_GAME_ID = 3;
export const ARKNIGHTS_GAME_ID = 1;

export type DailyGameScope = "endfield" | "arknights" | "both";

export interface NormalizedRole {
  gameId: number;
  roleId: string;
  serverId: string;
  nickname: string;
  channelMasterId?: string;
  /** The stored role object, or the object synthesized from the binding. */
  raw: any;
  synthesized: boolean;
  /** Additive: the binding's own uid (indieHard sends it as `userId`). */
  bindingUid?: string;
}

/** Maps a saved /daily game scope to the gameIds it covers. */
export function gameIdsForScope(scope: DailyGameScope): number[] {
  if (scope === "both") return [ARKNIGHTS_GAME_ID, ENDFIELD_GAME_ID];
  if (scope === "arknights") return [ARKNIGHTS_GAME_ID];
  return [ENDFIELD_GAME_ID];
}

/** Unwraps `{ bindingList: [...] }` app wrappers; plain bindings pass through. */
function flatten(bindings: unknown): any[] {
  if (!Array.isArray(bindings)) return [];
  const out: any[] = [];
  for (const item of bindings) {
    if (item && Array.isArray((item as any).bindingList)) {
      out.push(...(item as any).bindingList);
    } else {
      out.push(item);
    }
  }
  return out;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function synthesize(binding: any, gameId: number): any | null {
  if (!binding?.uid && !binding?.nickName) return null;
  return {
    roleId: String(binding?.uid || ""),
    serverId: String(binding?.channelMasterId || ""),
    nickname: String(
      binding?.nickName ||
        binding?.uid ||
        (gameId === ENDFIELD_GAME_ID ? "Endfield" : "Arknights"),
    ),
    level: 0,
    serverName: String(binding?.channelName || binding?.gameName || "-"),
  };
}

export function normalizeBindingRoles(
  bindings: any[] | null | undefined,
  gameIds: number[],
): NormalizedRole[] {
  const wanted = new Set(gameIds.map(Number));
  const out: NormalizedRole[] = [];

  for (const binding of flatten(bindings)) {
    if (!binding || typeof binding !== "object") continue;
    const gameId = Number(binding.gameId || 0);
    if (!wanted.has(gameId)) continue;

    let rawRoles: any[] = Array.isArray(binding.roles)
      ? binding.roles.filter(Boolean)
      : [];
    let synthesized = false;
    if (rawRoles.length === 0 && binding.defaultRole) {
      rawRoles = [binding.defaultRole];
    }
    if (rawRoles.length === 0) {
      const made = synthesize(binding, gameId);
      if (made) {
        rawRoles = [made];
        synthesized = true;
      }
    }

    for (const raw of rawRoles) {
      const roleId = str(raw.roleId ?? raw.uid ?? binding.uid);
      if (!roleId) continue;
      const serverId = str(raw.serverId ?? binding.channelMasterId);
      const nickname =
        str(raw.nickname || raw.nickName || (synthesized ? "" : binding.nickName)) ||
        roleId;
      const channelMasterId = str(binding.channelMasterId);
      out.push({
        gameId,
        roleId,
        serverId,
        nickname,
        ...(channelMasterId ? { channelMasterId } : {}),
        raw,
        synthesized,
        ...(binding.uid ? { bindingUid: String(binding.uid) } : {}),
      });
    }
  }

  return out;
}

/**
 * The role object attendance / card calls expect. For stored roles this equals the stored
 * object (same roleId / serverId / nickname); fallbacks only fill in missing fields.
 */
export function toAttendanceRole(role: NormalizedRole): any {
  return {
    ...role.raw,
    roleId: role.roleId,
    serverId: role.serverId,
    nickname: role.nickname,
  };
}

export function getPrimaryBindingRoleForGame(
  bindings: any[] | null | undefined,
  gameId: number,
): NormalizedRole | null {
  return normalizeBindingRoles(bindings, [gameId])[0] ?? null;
}
