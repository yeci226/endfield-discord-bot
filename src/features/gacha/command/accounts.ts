import { ensureAccountBinding, getAccounts } from "../../../utils/accountUtils";
import { CustomDatabase } from "../../../utils/Database";

export type PossibleUserRole = {
  uid: string;
  rawUid: string;
  bindingUid: string;
  nickname: string;
};

export function mapPossibleUserRoles(
  accounts: any[] | null | undefined,
): PossibleUserRole[] {
  const roles: PossibleUserRole[] = [];
  for (const acc of accounts ?? []) {
    if (!acc.roles) continue;
    for (const b of acc.roles) {
      if (Number(b.gameId) !== 3) continue;
      const bindingUid = String(b.uid || "");
      const add = (rUid: string, nick: string) => {
        roles.push({
          uid: `EF_${rUid}`,
          rawUid: rUid,
          bindingUid,
          nickname: nick,
        });
        roles.push({
          uid: `EF_CN_${rUid}`,
          rawUid: rUid,
          bindingUid,
          nickname: nick,
        });
      };
      const gameRoles = Array.isArray(b.roles)
        ? b.roles
        : b.defaultRole
          ? [b.defaultRole]
          : [];
      for (const r of gameRoles) {
        add(
          r.roleId || r.uid || b.uid,
          r.nickname || r.nickName || b.nickName || b.nickname || "Unknown",
        );
      }
    }
  }
  return roles;
}

// Move here for global access
export async function getAllPossibleUserRoles(userId: string, db: CustomDatabase) {
  const accounts = await getAccounts(db, userId);
  for (const acc of accounts ?? []) {
    await ensureAccountBinding(acc, userId, db, "tw");
  }
  return mapPossibleUserRoles(accounts);
}

/**
 * The account that owns this game UID, else the first usable account.
 * (Was copy-pasted three times in gacha.ts.)
 */
export function findLinkedAccount(
  userAccounts: any[],
  efGameUid: string | undefined,
): any {
  return (
    userAccounts.find((acc: any) => {
      if (!acc.cookie || !acc.info?.id || acc.invalid) return false;
      return acc.roles?.some(
        (b: any) => Number(b.gameId) === 3 && String(b.uid) === efGameUid,
      );
    }) ||
    userAccounts.find((acc: any) => acc.cookie && acc.info?.id && !acc.invalid)
  );
}
