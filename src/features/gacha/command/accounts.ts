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
 * The account that owns this game UID, or null when none does. There is
 * deliberately no fallback to "the first usable account": that would import
 * somebody else's history into this UID.
 */
export function findLinkedAccount(
  userAccounts: any[],
  efGameUid: string | undefined,
): any | null {
  if (!efGameUid) return null;
  return (
    userAccounts.find((acc: any) => {
      if (!acc.cookie || !acc.info?.id || acc.invalid) return false;
      return acc.roles?.some(
        (b: any) =>
          Number(b.gameId) === 3 &&
          (String(b.uid) === efGameUid ||
            (Array.isArray(b.roles) ? b.roles : []).some(
              (r: any) => String(r?.roleId || r?.uid) === efGameUid,
            )),
      );
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Ownership: which gacha-log UIDs may this Discord user write to?
// ---------------------------------------------------------------------------

export type OwnedUidResult =
  | { ok: true; uid: string }
  | { ok: false; reason: "empty" | "not_owned" };

/** Prefix of the guest log keys a user creates (the trailing "_" matters). */
export function guestUidPrefix(userId: string): string {
  return `EF_GUEST_${userId}_`;
}

/** True only for `EF_GUEST_<userId>_<something>` of exactly this user. */
export function isOwnGuestUid(uid: string, userId: string): boolean {
  const prefix = guestUidPrefix(userId);
  if (!userId || !uid.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]+$/.test(uid.slice(prefix.length));
}

/**
 * Every log UID the user's linked accounts own, in every key form the store
 * uses (bare id, EF_<id>, EF_CN_<id>), for the binding id and each role id,
 * plus the user's own guest keys (`guestUids` = guest keys found in the db;
 * anything not matching this user's guest prefix is dropped).
 */
export function listOwnedGachaUids(
  accounts: any[] | null | undefined,
  userId: string,
  guestUids: string[] = [],
): string[] {
  const owned = new Set<string>();
  const addId = (id: unknown) => {
    const s = String(id ?? "").trim();
    if (!s || s === "undefined" || s === "null") return;
    owned.add(s);
    owned.add(`EF_${s}`);
    owned.add(`EF_CN_${s}`);
  };
  for (const acc of accounts ?? []) {
    const entries = Array.isArray(acc?.roles)
      ? acc.roles.flatMap((entry: any) =>
          Array.isArray(entry?.bindingList) ? entry.bindingList : [entry],
        )
      : [];
    for (const binding of entries) {
      if (Number(binding?.gameId) !== 3) continue;
      addId(binding.uid);
      for (const role of [
        ...(Array.isArray(binding.roles) ? binding.roles : []),
        binding.defaultRole,
      ]) {
        addId(role?.roleId);
        addId(role?.uid);
      }
    }
  }
  for (const uid of guestUids) {
    if (isOwnGuestUid(uid, userId)) owned.add(uid);
  }
  return [...owned];
}

/** Pure decision: may the caller act on `requestedUid`? */
export function resolveOwnedGachaUid(
  requestedUid: string | null | undefined,
  ownedUids: Iterable<string>,
): OwnedUidResult {
  const uid = String(requestedUid ?? "").trim();
  if (!uid) return { ok: false, reason: "empty" };
  for (const owned of ownedUids) {
    if (owned === uid) return { ok: true, uid };
  }
  return { ok: false, reason: "not_owned" };
}

/**
 * Owned UIDs for a user, from stored accounts (no network) and the user's
 * guest keys (key-only index scan, no JSON parsing).
 */
export async function getOwnedGachaUids(
  db: CustomDatabase,
  userId: string,
): Promise<string[]> {
  const accounts = await getAccounts(db, userId);
  const guests = db
    .findKeysByPrefix(`GACHA_LOG_${guestUidPrefix(userId)}`)
    .map((k) => k.slice("GACHA_LOG_".length));
  return listOwnedGachaUids(accounts, userId, guests);
}
