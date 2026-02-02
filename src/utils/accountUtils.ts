import { CustomDatabase } from "./Database";
import { getGamePlayerBinding, verifyToken } from "./skportApi";
import { extractAccountToken } from "../commands/account/login";
import { decryptAccount, encryptAccount } from "./cryptoUtils";

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
): Promise<boolean> {
  // If we already have roles and we assume they are valid, we might skip.
  // BUT the user wants to fix 401s too, which means cred/salt might be stale even if roles exist.
  // However, forcing a check every time might be expensive/slow.
  // Compromise: We check if roles are missing OR if we explicitly want to validate.
  // For now, adhering to the "Auto-Rebind" logic primarily when roles are missing
  // or if prior 401s suggested invalidity.
  // Since we don't track 401 history easily here, we rely on the caller usually checks `!roles`
  // OR we can make this 'ensure' strict.
  // Given the user constraint "Auto-rebind accounts with missing roles" + "fix 401",
  // we will trigger this IF roles are missing OR if the caller suspects it's needed (context).
  // But to be safe and robust as a general utility, we'll run the check if roles are empty.
  // If roles exist, we assume they are fine UNLESS this function is called specifically to fix a 401.
  // To avoid over-engineering, we will stick to the "missing roles" trigger primarily,
  // but we can also check if `cred` or `salt` is missing.

  // We remove the early return optimization because we need to properly handle 401s (stale credentials).
  // Even if we have roles, the credentials might differ or be expired.
  // "Step 1" acts as a validity check.

  let rolesRestored = false;
  let bindingList: any[] = [];
  let newCred = account.cred;
  let newSalt = account.salt;
  let modified = false;

  // Step 1: Try with existing credentials if available
  // This serves as both a "check validity" and "refresh roles" step.
  if (account.cred && account.salt) {
    try {
      const bindings = await getGamePlayerBinding(
        undefined, // Try without cookie first to test cred validity
        lang,
        account.cred,
        account.salt,
      );
      const endfield = bindings?.find((b) => b.appCode === "endfield");
      if (endfield && endfield.bindingList) {
        bindingList = endfield.bindingList;
        rolesRestored = true;
      }
    } catch (e) {
      // Step 1 Failed (likely 401 or network), proceed to Step 2
    }
  }

  // Step 2: Full Re-verification if Step 1 failed or no creds
  if (!rolesRestored) {
    const token = extractAccountToken(account.cookie);
    if (token) {
      const verifyRes = await verifyToken(`ACCOUNT_TOKEN=${token}`, lang);
      if (
        verifyRes &&
        verifyRes.status === 0 &&
        verifyRes.cred &&
        (verifyRes as any).token // Check for token which acts as salt
      ) {
        newCred = verifyRes.cred;
        newSalt = (verifyRes as any).token;

        const bindings = await getGamePlayerBinding(
          account.cookie,
          lang,
          newCred,
          newSalt,
        );
        const endfield = bindings?.find((b) => b.appCode === "endfield");
        if (endfield && endfield.bindingList) {
          bindingList = endfield.bindingList;
          rolesRestored = true;
        }
      }
    }
  }

  // Save if we successfully restored/validated roles
  if (rolesRestored) {
    // Check if anything actually changed to avoid unnecessary DB writes
    const rolesChanged =
      JSON.stringify(account.roles) !== JSON.stringify(bindingList);
    const credsChanged = account.cred !== newCred || account.salt !== newSalt;

    if (rolesChanged || credsChanged) {
      account.roles = bindingList;
      account.cred = newCred;
      account.salt = newSalt;
      modified = true;

      // Save back to DB
      const allAccounts = await getAccounts(db, userId);
      if (allAccounts) {
        const idx = allAccounts.findIndex(
          (acc) => acc.info.id === account.info.id,
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
