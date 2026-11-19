import { normalizeBindingEntries } from "./accountUtils";

/**
 * Temporary local helper (L5). The main session swaps it for L3's
 * `normalizeBindingRoles` / `getPrimaryBindingRoleForGame` after merge.
 */
export const ENDFIELD_GAME_ID = 3;

export interface EndfieldRoleEntry {
  accountIndex: number;
  accountLabel: string;
  roleId: string;
  serverId: string;
  nickname: string;
  /** Server display name, when the binding provides one. */
  serverName: string;
  level: number;
  /** SKPORT user id used as the `userId` parameter of card endpoints. */
  skUserId: string;
}

const clean = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Lists every Endfield (gameId 3) role over all accounts. A gameId 3 binding
 * with `roles: []` and no `defaultRole` gets one synthesized role from the
 * binding's own `uid` / `nickName` / `channelMasterId`.
 */
export function listEndfieldRoles(accounts: any[] | null | undefined): EndfieldRoleEntry[] {
  const out: EndfieldRoleEntry[] = [];
  const seen = new Set<string>();
  (accounts || []).forEach((account, accountIndex) => {
    const accountLabel = clean(account?.info?.nickname || account?.info?.id || "SKPORT");
    for (const binding of normalizeBindingEntries(account?.roles)) {
      if (Number(binding?.gameId) !== ENDFIELD_GAME_ID) continue;
      let roles: any[] = Array.isArray(binding?.roles) && binding.roles.length
        ? binding.roles
        : binding?.defaultRole
          ? [binding.defaultRole]
          : [];
      if (roles.length === 0 && (binding?.uid || binding?.nickName)) {
        roles = [{
          roleId: clean(binding.uid),
          serverId: clean(binding.channelMasterId),
          nickname: clean(binding.nickName || binding.uid),
          level: 0,
          serverName: clean(binding.channelName || binding.gameName),
        }];
      }
      for (const role of roles) {
        const roleId = clean(role?.roleId);
        if (!roleId) continue;
        const serverId = clean(role?.serverId);
        const key = `${accountIndex}:${roleId}:${serverId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          accountIndex,
          accountLabel,
          roleId,
          serverId,
          nickname: clean(role?.nickname || role?.nickName || roleId),
          serverName: clean(role?.serverName),
          level: Number(role?.level) || 0,
          skUserId: clean(account?.info?.id || binding?.uid),
        });
      }
    }
  });
  return out;
}

/** Stable select-menu value for a role. */
export const roleKey = (r: Pick<EndfieldRoleEntry, "accountIndex" | "roleId" | "serverId">): string =>
  `${r.accountIndex}:${r.roleId}:${r.serverId}`;

export function findRoleByKey(roles: EndfieldRoleEntry[], key: string | undefined | null): EndfieldRoleEntry | undefined {
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
export function roleSelectOptions(roles: EndfieldRoleEntry[], selectedKey: string): RoleSelectOption[] {
  return roles.slice(0, 25).map((r) => ({
    label: r.nickname.slice(0, 100) || r.roleId,
    value: roleKey(r),
    description: [r.serverName, r.accountLabel].filter(Boolean).join(" · ").slice(0, 100) || "-",
    emoji: NUMBER_EMOJI[r.accountIndex] ?? "👤",
    default: roleKey(r) === selectedKey,
  }));
}
