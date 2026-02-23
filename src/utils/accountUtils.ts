import { CustomDatabase } from "./Database";
import {
  getGamePlayerBinding,
  verifyToken,
  refreshSkToken,
  refreshAccountToken,
} from "./skportApi";
import { extractAccountToken } from "../commands/account/login";
import { decryptAccount, encryptAccount } from "./cryptoUtils";
import { Logger } from "./Logger";

const logger = new Logger("AccountUtils");

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
  // Clear invalid flag and attempt full validation.
  // We don't early return here because we need to handle proactive checks and 401s.

  let rolesRestored = false;
  let bindingList: any[] = [];
  let newCred = account.cred;
  let newSalt = account.salt;
  let newCookie = account.cookie;
  let modified = false;

  const now = Date.now();
  const oldLastRefresh = account.lastRefresh || 0;

  // Fast-path: If verified within last 2 hours, skip Step 1 network call
  const isRecent = now - oldLastRefresh < 2 * 60 * 60 * 1000;
  if (
    !forceRefresh &&
    !account.invalid &&
    account.roles?.length > 0 &&
    isRecent
  ) {
    return false;
  }

  if (
    !account.invalid &&
    account.cookie &&
    (!account.roles || account.roles.length === 0)
  ) {
    // Initial fetch if roles are missing
    logger.info(
      `[Auth] Initial role capture for ${account.info?.id || "New Account"}...`,
    );
  }

  // Step 1: Try with existing credentials (fastest), unless forceRefresh is true
  if (!forceRefresh && !rolesRestored && account.cred && account.salt) {
    try {
      logger.info(
        `[Step 1] Attempting role check with existing credentials for ${account.info?.id}...`,
      );
      const bindings = await getGamePlayerBinding(
        undefined,
        lang,
        account.cred,
        account.salt,
      );
      const endfield = bindings?.find((b: any) => b.appCode === "endfield");
      if (endfield && endfield.bindingList) {
        bindingList = endfield.bindingList;
        rolesRestored = true;
        logger.success(`[Step 1] Success! Credentials are still valid.`);
      }
    } catch (e: any) {
      logger.warn(`[Step 1] Failed: ${e.message}`);
    }
  }

  // Step 2: Try Refreshing Salt with Cred
  if (!rolesRestored && account.cred) {
    logger.info(
      `[Step 2] Attempting to refresh salt with cred for ${account.info?.id}...`,
    );
    const newToken = await refreshSkToken(account.cred);
    if (newToken) {
      newSalt = newToken;
      try {
        const bindings = await getGamePlayerBinding(
          undefined,
          lang,
          account.cred,
          newSalt,
        );
        const endfield = bindings?.find((b: any) => b.appCode === "endfield");
        if (endfield && endfield.bindingList) {
          bindingList = endfield.bindingList;
          // IMPORTANT: If we are already in an onStale loop, Step 2 success might be a false positive
          // if the target endpoint (card/detail) still fails.
          // However, ensureAccountBinding doesn't know the target endpoint.
          // We'll mark it as rolesRestored but let Step 3 handle it if called again.
          rolesRestored = true;
          logger.success(`[Step 2] Success! Refreshed salt works.`);
        }
      } catch (e: any) {
        logger.warn(`[Step 2] Failed: ${e.message}`);
      }
    } else {
      logger.warn(`[Step 2] refreshSkToken returned null.`);
    }
  }

  // FORCE Step 3 if we are here and still haven't found Endfield bindings OR if Step 2 failed
  // Sometimes binding list is empty even if cred/salt works if the session is partially dead.

  // Step 3: Refresh Master Cookie (ACCOUNT_TOKEN) if still failed
  if (!rolesRestored && account.cookie) {
    logger.info(
      `[Step 3] Attempting Master token refresh for ${account.info?.id}...`,
    );
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

        const bindings = await getGamePlayerBinding(
          newCookie,
          lang,
          newCred,
          newSalt,
        );
        const endfield = bindings?.find((b: any) => b.appCode === "endfield");
        if (endfield && endfield.bindingList) {
          bindingList = endfield.bindingList;
          rolesRestored = true;
          logger.success(`[Step 3] Success! Full session restored.`);
        } else {
          logger.warn(
            `[Step 3] Token verified but couldn't get game bindings.`,
          );
        }
      } else {
        logger.warn(`[Step 3] verifyToken failed or returned invalid status.`);
      }
    } else {
      logger.warn(`[Step 3] refreshAccountToken returned null.`);
    }
  }

  // Final Step: If still not restored, mark as invalid to prevent further retries
  if (!rolesRestored) {
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

  // Successful restoration or already valid - clear invalid flag
  if (account.invalid) {
    account.invalid = false;
    modified = true;
  }

  // Save if we successfully restored/validated roles
  if (rolesRestored) {
    // Check if anything actually changed to avoid unnecessary DB writes
    const rolesChanged =
      bindingList.length > 0 &&
      JSON.stringify(account.roles) !== JSON.stringify(bindingList);
    const credsChanged = account.cred !== newCred || account.salt !== newSalt;
    const cookieChanged = account.cookie !== newCookie;
    const heartbeatUpdated = account.lastRefresh !== oldLastRefresh;

    if (rolesChanged || credsChanged || cookieChanged || heartbeatUpdated) {
      if (bindingList.length > 0) account.roles = bindingList;
      account.cred = newCred;
      account.salt = newSalt;
      account.cookie = newCookie;
      // account.lastRefresh is already updated above if needed
      modified = true;

      // Save back to DB
      const allAccounts = await getAccounts(db, userId);
      if (allAccounts) {
        const idx = allAccounts.findIndex(
          (acc: any) => acc.info.id === account.info.id,
        );
        if (idx !== -1) {
          allAccounts[idx] = account; // account is already decrypted at runtime
          await saveAccounts(db, userId, allAccounts);
        }
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
