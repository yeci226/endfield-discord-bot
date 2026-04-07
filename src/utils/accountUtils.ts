import { CustomDatabase } from "./Database";
import {
  getGamePlayerBinding,
  getGamePlayerBindingResponse,
  getUserInfo,
  verifyToken,
  refreshSkToken,
  refreshAccountToken,
} from "./skportApi";
import { extractAccountToken } from "../commands/account/login";
import { decryptAccount, encryptAccount } from "./cryptoUtils";
import { Logger } from "./Logger";

const logger = new Logger("AccountUtils");

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
  let accounts = (await db.get(`${userId}.accounts`)) as any[];
  if (!accounts) {
    // Migration check for very old formats
    const oldCookie = await db.get(`${userId}.cookie`);
    const oldInfo = await db.get(`${userId}.info`);
    if (oldCookie && oldInfo) {
      accounts = [{ cookie: oldCookie, info: oldInfo }];
      // Note: saveAccounts will handle encrypting this if key is present
      await saveAccounts(db, userId, accounts);
    } else {
      accounts = [];
    }
  }

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
  const encrypted = accounts.map((acc: any) => encryptAccount(acc));
  await db.set(`${userId}.accounts`, encrypted);
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
  // 只驗證 cred/cookie 是否有效，並可正常呼叫 getAttendanceList
  let modified = false;
  let newCred = account.cred;
  let newSalt = account.salt;
  let newCookie = account.cookie;
  const now = Date.now();
  const oldLastRefresh = account.lastRefresh || 0;
  const isRecent = now - oldLastRefresh < 2 * 60 * 60 * 1000;

  if (
    !forceRefresh &&
    !account.invalid &&
    isRecent &&
    Array.isArray(account.roles) &&
    account.roles.length > 0
  ) {
    return false;
  }

  // Step 1: 嘗試用現有 cred/salt 呼叫 getUserInfo
  let valid = false;
  if (!forceRefresh && account.cred && account.salt) {
    try {
      logger.info(`[Step 1] 檢查現有憑證是否有效 for ${account.info?.id}...`);
      const res = await getUserInfo(account.cred, lang, account.salt);
      if (res && res.code === 0) {
        valid = true;
        logger.success(
          `[Step 1] 憑證有效，主動刷新 salt 以確保後續 API 可用...`,
        );
        // Binding endpoint 對 salt 過期容忍度嚴格，即使 getUserInfo 成功也需刷新
        const refreshed = await refreshSkToken(account.cred, "3", newSalt);
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
    const newToken = await refreshSkToken(account.cred, "3", newSalt);
    if (newToken) {
      newSalt = newToken;
      try {
        const res = await getUserInfo(account.cred, lang, newSalt);
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
    const newTokenValue = await refreshAccountToken(account.cookie);
    if (newTokenValue) {
      newCookie = `ACCOUNT_TOKEN=${newTokenValue}`;
      const verifyRes = await verifyToken(newCookie, lang);
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
          const res = await getUserInfo(newCred, lang, newSalt);
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
    if (!account.invalid) {
      account.invalid = true;
      modified = true;
      // Save back to DB
      const allAccounts = await getAccounts(db, userId);
      if (allAccounts) {
        const idx = allAccounts.findIndex(
          (acc: any) => acc.info.id === account.info.id,
        );
        if (idx !== -1) {
          allAccounts[idx] = account;
          await saveAccounts(db, userId, allAccounts);
        }
      }
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
      getGamePlayerBindingResponse(undefined, lang, newCred, newSalt);

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
  if (credsChanged || cookieChanged || rolesChanged || !isRecent) {
    account.cred = newCred;
    account.salt = newSalt;
    account.cookie = newCookie;
    account.roles = latestBindings;
    account.lastRefresh = now;
    modified = true;
    // Save back to DB
    const allAccounts = await getAccounts(db, userId);
    if (allAccounts) {
      const idx = allAccounts.findIndex(
        (acc: any) => acc.info.id === account.info.id,
      );
      if (idx !== -1) {
        allAccounts[idx] = account;
        await saveAccounts(db, userId, allAccounts);
      }
    }
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
