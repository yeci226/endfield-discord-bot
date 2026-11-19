import { CustomDatabase } from "./Database";
import { accountId, patchAccount, writeAccounts } from "./accountData";
import {
  getGamePlayerBinding,
  getGamePlayerBindingResponse,
  getUserInfo,
  verifyToken,
  refreshSkToken,
  refreshAccountToken,
  isAuthRejectionCode,
  isTransientFailure,
  RequestFailure,
} from "./skportApi";
import { extractAccountToken } from "../commands/account/login";
import { decryptAccount, encryptAccount } from "./cryptoUtils";
import { Logger } from "./Logger";
import {
  ARKNIGHTS_GAME_ID,
  ENDFIELD_GAME_ID,
} from "./bindingRoles";

const logger = new Logger("AccountUtils");

/**
 * Accounts whose last refresh could not tell whether the login is dead (network error,
 * timeout, 5xx/429, or no explicit rejection). Not persisted; only meaningful right after
 * ensureAccountBinding returned.
 */
const inconclusiveAccounts = new WeakSet<object>();

export function wasRefreshInconclusive(account: any): boolean {
  return !!account && typeof account === "object" && inconclusiveAccounts.has(account);
}

function flattenBindingList(bindings: any[] | null | undefined): any[] {
  if (!Array.isArray(bindings)) return [];
  const out: any[] = [];
  for (const app of bindings) {
    if (Array.isArray(app?.bindingList)) {
      out.push(...app.bindingList);
    }
  }
  return out;
}

export function normalizeBindingEntries(
  bindings: any[] | null | undefined,
): any[] {
  if (!Array.isArray(bindings)) return [];

  const out: any[] = [];
  for (const item of bindings) {
    if (Array.isArray(item?.bindingList)) {
      out.push(...item.bindingList);
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * True when the stored bindings include an Arknights or Endfield binding. A recent refresh
 * that found such a binding is not repeated even if the binding has no role (176 Endfield
 * bindings in production have none), otherwise those accounts would refresh on every use.
 */
function hasSupportedBinding(bindings: any[] | null | undefined): boolean {
  return normalizeBindingEntries(bindings).some((b) =>
    [ARKNIGHTS_GAME_ID, ENDFIELD_GAME_ID].includes(Number(b?.gameId)),
  );
}

/**
 * @deprecated Returns the first role of ANY game, so on a mixed account the Arknights role
 * can come back where an Endfield role is expected. Use getPrimaryBindingRoleForGame from
 * ./bindingRoles. Kept only for callers outside lane L3.
 */
export function getPrimaryBindingRole(
  bindings: any[] | null | undefined,
): { binding: any; role: any } | null {
  const normalized = normalizeBindingEntries(bindings);

  for (const binding of normalized) {
    const roles = Array.isArray(binding?.roles)
      ? binding.roles
      : binding?.defaultRole
        ? [binding.defaultRole]
        : [];
    const role = roles[0];
    if (role) {
      return { binding, role };
    }
  }

  return null;
}

/**
 * Ensures that the account has valid bindings (roles) and credentials.
 * Implements a robust 2-step check:
 * 1. Try existing cred/salt (fastest).
 * 2. Fallback to full re-verification (refresh token).
 *
 * Updates the DB if changes are made.
 *
 * @param account The account object from the database
 * @param userId The Discord user ID owning this account
 * @param db The database instance
 * @param lang Language code for API requests
 * @returns True if the account was modified (and saved), false otherwise.
 */

/**
 * Gets and migrates accounts. Decrypts sensitive fields for use.
 */
export const getAccounts = async (
  db: CustomDatabase,
  userId: string,
): Promise<any[]> => {
  const accounts = db.transaction((store) => {
    const key = `${userId}.accounts`;
    const current = store.get<any[]>(key);
    if (current) return current;
    const oldCookie = store.get(`${userId}.cookie`);
    const oldInfo = store.get(`${userId}.info`);
    if (!oldCookie || !oldInfo) return [];
    const migrated = [encryptAccount({ cookie: oldCookie, info: oldInfo })];
    store.set(key, migrated);
    return migrated;
  });

  // Decrypt all accounts for runtime use
  return (accounts || []).map((acc: any) => decryptAccount(acc));
};

/**
 * Encrypts and saves accounts to the database.
 */
export const saveAccounts = async (
  db: CustomDatabase,
  userId: string,
  accounts: any[],
): Promise<void> => {
  writeAccounts(db, userId, accounts);
};

/**
 * Ensures that the account has valid bindings (roles) and credentials.
 * @returns True if the account was modified (and saved), false otherwise.
 */
export async function ensureAccountBinding(
  account: any,
  userId: string,
  db: CustomDatabase,
  lang: string,
  forceRefresh: boolean = false,
): Promise<boolean> {
  const startedAt = Date.now();
  const isRecent = startedAt - (account.lastRefresh || 0) < 2 * 60 * 60 * 1000;

  if (
    !forceRefresh &&
    !account.invalid &&
    isRecent &&
    hasSupportedBinding(account.roles)
  ) {
    return false;
  }

  // One refresh at a time per user, so a daily run and a reminder poll cannot refresh the
  // same tokens concurrently and overwrite each other. The lock is not reentrant: nothing
  // inside refreshAccountBinding may call ensureAccountBinding / withAutoRefresh again.
  return db.withKeyLock("acct:" + userId, () =>
    refreshAccountBinding(account, userId, db, lang, forceRefresh, startedAt),
  );
}

function readStoredAccount(
  db: CustomDatabase,
  userId: string,
  id: string,
): any | null {
  const list = db.transaction((store) =>
    store.get<any[]>(`${userId}.accounts`),
  );
  const found = Array.isArray(list)
    ? list.find((item) => accountId(item) === id)
    : null;
  return found ? decryptAccount(found) : null;
}

async function refreshAccountBinding(
  account: any,
  userId: string,
  db: CustomDatabase,
  lang: string,
  forceRefresh: boolean,
  startedAt: number,
): Promise<boolean> {
  const id = accountId(account);
  inconclusiveAccounts.delete(account);

  // Somebody else refreshed this account while we waited for the lock: use their result.
  const stored = id ? readStoredAccount(db, userId, id) : null;
  if (
    stored &&
    !stored.invalid &&
    stored.cred &&
    (stored.lastRefresh || 0) >= startedAt
  ) {
    account.cred = stored.cred;
    account.salt = stored.salt;
    account.cookie = stored.cookie;
    account.roles = stored.roles;
    account.lastRefresh = stored.lastRefresh;
    account.invalid = false;
    delete account.tokenExpiredNotified;
    return true;
  }

  // 只驗證 cred/cookie 是否有效，並可正常呼叫 getAttendanceList
  let modified = false;
  let newCred = account.cred;
  let newSalt = account.salt;
  let newCookie = account.cookie;
  const now = Date.now();
  const oldLastRefresh = account.lastRefresh || 0;
  const isRecent = now - oldLastRefresh < 2 * 60 * 60 * 1000;
  const wasInvalid = !!account.invalid;

  // What the failed steps told us. Only an explicit rejection (HTTP 401/403, "not logged in"
  // codes) may mark the account invalid; a timeout, network error, 5xx or 429 proves nothing.
  inconclusiveAccounts.delete(account);
  const probe = { transient: false, auth: false };
  const onError = (failure: RequestFailure) => {
    if (isTransientFailure(failure)) probe.transient = true;
    else if (failure.kind === "auth") probe.auth = true;
  };
  const noteBody = (res: any) => {
    if (res && res.code !== 0 && isAuthRejectionCode(res.code, res.status)) {
      probe.auth = true;
    }
  };
  // Nothing to log in with: unusable without asking anyone.
  if (!account.cred && !account.cookie) probe.auth = true;

  // Step 1: 嘗試用現有 cred/salt 呼叫 getUserInfo
  let valid = false;
  if (!forceRefresh && account.cred && account.salt) {
    try {
      logger.info(`[Step 1] 檢查現有憑證是否有效 for ${account.info?.id}...`);
      const res = await getUserInfo(account.cred, lang, account.salt, onError);
      noteBody(res);
      if (res && res.code === 0) {
        valid = true;
        logger.success(
          `[Step 1] 憑證有效，主動刷新 salt 以確保後續 API 可用...`,
        );
        // Binding endpoint 對 salt 過期容忍度嚴格，即使 getUserInfo 成功也需刷新
        const refreshed = await refreshSkToken(account.cred, "3", newSalt, onError);
        if (refreshed) {
          newSalt = refreshed;
          logger.success(`[Step 1] salt 已更新`);
        }
      }
    } catch (e: any) {
      logger.warn(`[Step 1] 憑證驗證失敗: ${e.message}`);
    }
  }

  // Step 2: 嘗試刷新 salt
  if (!valid && account.cred) {
    logger.info(`[Step 2] 嘗試 refreshSkToken for ${account.info?.id}...`);
    const newToken = await refreshSkToken(account.cred, "3", newSalt, onError);
    if (newToken) {
      newSalt = newToken;
      try {
        const res = await getUserInfo(account.cred, lang, newSalt, onError);
        noteBody(res);
        if (res && res.code === 0) {
          valid = true;
          logger.success(`[Step 2] salt 刷新後憑證有效`);
        }
      } catch (e: any) {
        logger.warn(`[Step 2] 憑證驗證失敗: ${e.message}`);
      }
    } else {
      logger.warn(`[Step 2] refreshSkToken 回傳 null`);
    }
  }

  // Step 3: 嘗試刷新 cookie/token
  if (!valid && account.cookie) {
    logger.info(`[Step 3] 嘗試 refreshAccountToken for ${account.info?.id}...`);
    const newTokenValue = await refreshAccountToken(account.cookie, onError);
    if (newTokenValue) {
      newCookie = `ACCOUNT_TOKEN=${newTokenValue}`;
      const verifyRes = await verifyToken(newCookie, lang, onError);
      if (
        verifyRes &&
        verifyRes.status === 0 &&
        verifyRes.cred &&
        verifyRes.token
      ) {
        newCred = verifyRes.cred;
        newSalt = verifyRes.token;
        account.lastRefresh = now;
        try {
          const res = await getUserInfo(newCred, lang, newSalt, onError);
          noteBody(res);
          if (res && res.code === 0) {
            valid = true;
            logger.success(`[Step 3] cookie/token 刷新後憑證有效`);
          }
        } catch (e: any) {
          logger.warn(`[Step 3] 憑證驗證失敗: ${e.message}`);
        }
      } else {
        logger.warn(`[Step 3] verifyToken 失敗或回傳無效`);
      }
    } else {
      logger.warn(`[Step 3] refreshAccountToken 回傳 null`);
    }
  }

  // 最終判斷
  if (!valid) {
    if (probe.transient || !probe.auth) {
      // Could not tell (outage, timeout, rate limit, or no explicit rejection): leave the
      // stored flag as it is and let the caller treat this as "unknown", not "dead".
      inconclusiveAccounts.add(account);
      logger.warn(
        `[Refresh] ${account.info?.id}: login could not be verified (transient=${probe.transient}, rejected=${probe.auth}); not marking invalid.`,
      );
      return false;
    }
    if (!account.invalid) {
      account.invalid = true;
      modified = true;
      // Save back to DB (patch only this flag; the in-memory account may be stale)
      patchAccount(db, userId, id, { invalid: true });
    }
    return modified;
  }

  // 憑證有效，清除 invalid 標記
  if (account.invalid) {
    account.invalid = false;
    modified = true;
  }

  // Sync latest game bindings (Arknights + Endfield) for migration and autocomplete.
  // The binding endpoint is called without Cookie (WAF blocks requests that include it).
  let latestBindings: any[] = Array.isArray(account.roles) ? account.roles : [];
  try {
    const fetchBindings = async () =>
      getGamePlayerBindingResponse(
        undefined,
        lang,
        newCred,
        newSalt,
        {},
        account.info?.id,
      );

    let bindingRes = await fetchBindings();
    if (bindingRes && bindingRes.code === 0) {
      const flattened = flattenBindingList(bindingRes.data?.list);
      if (flattened.length > 0) {
        latestBindings = flattened;
      }
    } else if (
      bindingRes?.status === 401 &&
      bindingRes?.code !== 10003 &&
      newCred
    ) {
      // Refresh salt and retry
      const refreshedSalt = await refreshSkToken(newCred, "3", newSalt);
      if (refreshedSalt) {
        newSalt = refreshedSalt;
        bindingRes = await fetchBindings();
        if (bindingRes && bindingRes.code === 0) {
          const flattened = flattenBindingList(bindingRes.data?.list);
          if (flattened.length > 0) {
            latestBindings = flattened;
          }
        }
      }

      // Last resort: refresh cookie and re-verify cred+salt, then retry binding
      if (!(bindingRes && bindingRes.code === 0) && account.cookie) {
        const refreshedToken = await refreshAccountToken(account.cookie);
        if (refreshedToken) {
          newCookie = `ACCOUNT_TOKEN=${refreshedToken}`;
          const verifyRes = await verifyToken(newCookie, lang);
          if (
            verifyRes &&
            verifyRes.status === 0 &&
            verifyRes.cred &&
            verifyRes.token
          ) {
            newCred = verifyRes.cred;
            newSalt = verifyRes.token;
            const retryRes = await fetchBindings();
            if (retryRes && retryRes.code === 0) {
              const flattened = flattenBindingList(retryRes.data?.list);
              if (flattened.length > 0) {
                latestBindings = flattened;
              }
            }
          }
        }
      }
    }
  } catch (e: any) {
    logger.warn(`[Binding Sync] Failed to refresh bindings: ${e.message}`);
  }

  // 若有更新憑證資訊則存回 DB；無論如何都更新 lastRefresh 讓 isRecent 快取生效
  const credsChanged = account.cred !== newCred || account.salt !== newSalt;
  const cookieChanged = account.cookie !== newCookie;
  const rolesChanged =
    JSON.stringify(account.roles || []) !==
    JSON.stringify(latestBindings || []);
  if (credsChanged || cookieChanged || rolesChanged || !isRecent || wasInvalid) {
    account.cred = newCred;
    account.salt = newSalt;
    account.cookie = newCookie;
    account.roles = latestBindings;
    // Completion time: a caller that waited on the lock started before it and can adopt it.
    const savedAt = Date.now();
    account.lastRefresh = savedAt;
    // A working token again: the "please /login" notice may be sent again next time.
    delete account.tokenExpiredNotified;
    modified = true;
    // Save back to DB: patch only what a refresh owns, re-reading the list in the transaction
    patchAccount(db, userId, id, {
      invalid: false,
      cred: newCred,
      salt: newSalt,
      cookie: newCookie,
      roles: latestBindings,
      lastRefresh: savedAt,
      tokenExpiredNotified: undefined,
    });
  }

  return modified;
}

/**
 * A generic wrapper that provides auto-refresh capabilities to any SKPort API action.
 *
 * @param client ExtendedClient instance
 * @param userId Discord User ID
 * @param account The account object (will be modified if refreshed)
 * @param action A callback that receives (cred, salt, options) and returns a promise
 * @param locale Language for the refresh logic
 */
export async function withAutoRefresh<T>(
  client: any,
  userId: string,
  account: any,
  action: (cred: string, salt: string, options: any) => Promise<T>,
  locale: string = "tw",
): Promise<T> {
  if (account.invalid) {
    const error = new Error("TokenExpired");
    (error as any).code = 10000;
    throw error;
  }

  // Purely Reactive: No more proactive timers.
  // ensureAccountBinding will only be called by onStale (when 401 occurs) or if roles are missing.

  const onStale = async (options: any) => {
    logger.info(
      `[Auth] 401 detected. Triggering reactive session restoration for ${account.info?.id}...`,
    );
    const wasModified = await ensureAccountBinding(
      account,
      userId,
      client.db,
      locale,
      true, // forceRefresh
    );
    if (wasModified && !account.invalid) {
      options.cred = account.cred;
      options.salt = account.salt;
      return true;
    }
    return false;
  };

  return action(account.cred, account.salt, { onStale, locale });
}
