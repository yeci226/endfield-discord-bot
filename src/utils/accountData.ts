import { createHash } from "node:crypto";
import { CustomDatabase } from "./Database";
import { encryptAccount } from "./cryptoUtils";

export const accountId = (account: any): string =>
  String(account?.info?.id || account?.info?.uid || "");

/** Fingerprint the stored snapshot, so an old prompt cannot delete a rebound account. */
export const accountFingerprint = (account: any): string =>
  createHash("sha256")
    .update(JSON.stringify(account))
    .digest("hex")
    .slice(0, 32);

export function writeAccounts(
  db: CustomDatabase,
  userId: string,
  accounts: any[],
  allowInsert = false,
): void {
  const encrypted = accounts.map(encryptAccount);
  db.transaction((store) => {
    const key = `${userId}.accounts`;
    const current = store.get<any[]>(key) || [];
    for (const account of encrypted) {
      const id = accountId(account);
      if (!id) throw new Error("Account ID is required");
      const index = current.findIndex((item) => accountId(item) === id);
      if (index >= 0) current[index] = account;
      else if (allowInsert) {
        if (current.length >= 5) throw new Error("Account limit reached (5)");
        current.push(account);
      }
    }
    // A stale background refresh must not recreate a deleted account list.
    if (current.length) store.set(key, current);
  });
}

/**
 * Patches ONE account of `<userId>.accounts` in a single transaction. The list is re-read
 * inside the transaction, so a stale in-memory account cannot overwrite fields written by
 * somebody else meanwhile; only the keys in `patch` change. Secret fields (cookie / cred /
 * salt) in the patch are encrypted. A key whose value is `undefined` is removed.
 * Returns false (and writes nothing) if the user or the account no longer exists.
 */
export function patchAccount(
  db: CustomDatabase,
  userId: string,
  id: string,
  patch: Record<string, unknown>,
): boolean {
  if (!id) return false;
  const encrypted = encryptAccount({ ...patch });
  return db.transaction((store) => {
    const key = `${userId}.accounts`;
    const current = store.get<any[]>(key);
    if (!Array.isArray(current)) return false;
    const index = current.findIndex((item) => accountId(item) === id);
    if (index < 0) return false;
    const next = { ...current[index] };
    for (const [field, value] of Object.entries(encrypted)) {
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    current[index] = next;
    store.set(key, current);
    return true;
  });
}

function gameIds(account: any): Set<string> {
  const ids = new Set<string>();
  const entries = Array.isArray(account?.roles)
    ? account.roles.flatMap((entry: any) =>
        Array.isArray(entry?.bindingList) ? entry.bindingList : [entry],
      )
    : [];
  for (const binding of entries) {
    if (Number(binding?.gameId) !== 3) continue;
    if (binding.uid) ids.add(String(binding.uid));
    for (const role of [
      ...(Array.isArray(binding.roles) ? binding.roles : []),
      binding.defaultRole,
    ]) {
      const id = role?.roleId || role?.uid;
      if (id) ids.add(String(id));
    }
  }
  return ids;
}

/** Deletes only data attributable to this bound account, in one SQLite transaction. */
export function deleteAccountData(
  db: CustomDatabase,
  userId: string,
  fingerprint: string,
): any | null {
  return db.transaction((store) => {
    const key = `${userId}.accounts`;
    const accounts = store.get<any[]>(key) || [];
    const index = accounts.findIndex(
      (account) => accountFingerprint(account) === fingerprint,
    );
    if (index < 0) return null;
    const [removed] = accounts.splice(index, 1);
    const id = accountId(removed);
    if (!id) throw new Error("Account ID is required");
    const ids = gameIds(removed);
    for (const remaining of accounts)
      for (const shared of gameIds(remaining)) ids.delete(shared);
    const leaderboard = store.get<Record<string, unknown>>(
      "GACHA_LEADERBOARD_ENTRIES",
    );
    for (const gameId of ids) {
      for (const uid of [gameId, `EF_${gameId}`, `EF_CN_${gameId}`]) {
        store.delete(`GACHA_LOG_${uid}`);
        store.delete(`SIM_POOL_RECORDS.${uid}`);
        if (leaderboard) delete leaderboard[uid];
      }
      store.delete(`warEchoes.history.${gameId}`);
    }
    if (leaderboard) store.set("GACHA_LEADERBOARD_ENTRIES", leaderboard);
    for (const prefix of [
      `reminder.v2.${userId}.${id}.`,
      `reminderState.v2.${userId}.${id}.`,
    ]) {
      for (const entry of store.keys(prefix)) store.delete(entry);
    }
    const oldInfo = store.get<any>(`${userId}.info`);
    if (!accounts.length || String(oldInfo?.id || oldInfo?.uid || "") === id) {
      for (const field of ["cookie", "info", "cred", "salt", "roles"])
        store.delete(`${userId}.${field}`);
    }
    // Pending import URLs may contain credentials for the removed account.
    store.delete(`PENDING_GACHA_URL_${userId}`);
    store.delete(`PENDING_GACHA_FINGERPRINT_${userId}`);
    // Wizard drafts include cached player details and the owner's account list.
    for (const entry of store.keys("reminderWizard.session.v1."))
      if (store.get<any>(entry)?.owner === userId) store.delete(entry);
    if (accounts.length) store.set(key, accounts);
    else {
      store.delete(key);
      for (const entry of [
        `autoDaily.${userId}`,
        `${userId}.lastAutoDaily`,
        `autoDailyState.${userId}`,
        `${userId}.autoDailyHour`,
        `profile.${userId}.template`,
      ])
        store.delete(entry);
      for (const prefix of [
        `reminder.v2.${userId}.`,
        `reminderState.v2.${userId}.`,
      ])
        for (const entry of store.keys(prefix)) store.delete(entry);
      for (const mapKey of ["autoDaily", "monitorConfig"]) {
        const map = store.get<Record<string, unknown>>(mapKey);
        if (map && Object.prototype.hasOwnProperty.call(map, userId)) {
          delete map[userId];
          store.set(mapKey, map);
        }
      }
      for (const entry of store.keys("profile_edit_token:"))
        if (store.get<any>(entry)?.userId === userId) store.delete(entry);
    }
    return { info: removed.info };
  });
}
