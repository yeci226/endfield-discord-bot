/**
 * One place that turns SKPort "bindings" (what `account.roles` stores) into roles.
 *
 * Rules that keep existing users on the same role:
 *  - A binding that already has non-empty `roles` (or a `defaultRole`) returns exactly those
 *    roles; `raw` is the stored object, `roleId`/`serverId` are not rewritten.
 *  - A role is synthesized from the binding itself only when it has neither, and ONLY for
 *    gameId 1 (Arknights), where the synthesized object is identical to what daily.ts /
 *    AutoDailyService.ts built before. Never for Endfield: an Endfield binding's `uid` /
 *    `channelMasterId` are not the role's roleId / serverId (measured on production
 *    2026-11-19, see the note below), so an Endfield binding without roles has no role.
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

/** Arknights only (see the header). */
function synthesize(binding: any): any | null {
  if (!binding?.uid && !binding?.nickName) return null;
  return {
    roleId: String(binding?.uid || ""),
    serverId: String(binding?.channelMasterId || ""),
    nickname: String(binding?.nickName || binding?.uid || "Arknights"),
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
    if (rawRoles.length === 0 && gameId === ARKNIGHTS_GAME_ID) {
      const made = synthesize(binding);
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

export type EndfieldTarget =
  | {
      ok: true;
      account: any;
      accountIndex: number;
      role: NormalizedRole;
    }
  | { ok: false; reason: "no_account" | "account_not_found" | "no_endfield_role" };

/**
 * Picks the account + Endfield role a command should use.
 * - no accounts                                  -> no_account
 * - `requestedIndex` given but out of range       -> account_not_found
 * - not given: the first account that has an Endfield role (else the first account)
 * - the chosen account has no Endfield role (e.g. Arknights only) -> no_endfield_role
 */
export function resolveEndfieldTarget(
  accounts: any[] | null | undefined,
  requestedIndex?: number | null,
): EndfieldTarget {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, reason: "no_account" };
  }
  let accountIndex: number;
  if (requestedIndex === undefined || requestedIndex === null) {
    const found = accounts.findIndex(
      (a) => getPrimaryBindingRoleForGame(a?.roles, ENDFIELD_GAME_ID) !== null,
    );
    accountIndex = found >= 0 ? found : 0;
  } else {
    if (
      !Number.isInteger(requestedIndex) ||
      requestedIndex < 0 ||
      requestedIndex >= accounts.length
    ) {
      return { ok: false, reason: "account_not_found" };
    }
    accountIndex = requestedIndex;
  }
  const account = accounts[accountIndex];
  const role = getPrimaryBindingRoleForGame(account?.roles, ENDFIELD_GAME_ID);
  if (!role) return { ok: false, reason: "no_endfield_role" };
  return { ok: true, account, accountIndex, role };
}

// ---- Role list / picker for the commands that pick one Endfield role (stamina, crisis) ----

export interface EndfieldRoleEntry {
  accountIndex: number;
  accountLabel: string;
  roleId: string;
  serverId: string;
  nickname: string;
  /** Server display name, when the role provides one. */
  serverName: string;
  level: number;
  /** SKPORT user id used as the `userId` parameter of card endpoints (unchanged from before). */
  skUserId: string;
}

/**
 * Every Endfield (gameId 3) role over all accounts, in account order. Bindings without a role
 * contribute nothing (see the header: Endfield roles are never synthesized).
 */
export function listEndfieldRoles(
  accounts: any[] | null | undefined,
): EndfieldRoleEntry[] {
  const out: EndfieldRoleEntry[] = [];
  const seen = new Set<string>();
  (accounts || []).forEach((account, accountIndex) => {
    const accountLabel = str(
      account?.info?.nickname || account?.info?.id || "SKPORT",
    );
    for (const role of normalizeBindingRoles(account?.roles, [ENDFIELD_GAME_ID])) {
      const key = `${accountIndex}:${role.roleId}:${role.serverId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        accountIndex,
        accountLabel,
        roleId: role.roleId,
        serverId: role.serverId,
        nickname: role.nickname,
        serverName: str(role.raw?.serverName),
        level: Number(role.raw?.level) || 0,
        skUserId: str(account?.info?.id || role.bindingUid),
      });
    }
  });
  return out;
}

/** Stable select-menu value for a role. */
export const roleKey = (
  r: Pick<EndfieldRoleEntry, "accountIndex" | "roleId" | "serverId">,
): string => `${r.accountIndex}:${r.roleId}:${r.serverId}`;

export function findRoleByKey(
  roles: EndfieldRoleEntry[],
  key: string | undefined | null,
): EndfieldRoleEntry | undefined {
  return roles.find((r) => roleKey(r) === key);
}

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

export interface RoleSelectOption {
  label: string;
  value: string;
  description: string;
  emoji: string;
  default: boolean;
}

/** Plain option data for a role picker (Discord allows at most 25 options). */
export function roleSelectOptions(
  roles: EndfieldRoleEntry[],
  selectedKey: string,
): RoleSelectOption[] {
  return roles.slice(0, 25).map((r) => ({
    label: r.nickname.slice(0, 100) || r.roleId,
    value: roleKey(r),
    description:
      [r.serverName, r.accountLabel].filter(Boolean).join(" · ").slice(0, 100) || "-",
    emoji: NUMBER_EMOJI[r.accountIndex] ?? "👤",
    default: roleKey(r) === selectedKey,
  }));
}
