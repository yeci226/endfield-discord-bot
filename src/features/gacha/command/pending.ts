import { CustomDatabase } from "../../../utils/Database";
import { decrypt, encrypt } from "../../../utils/cryptoUtils";

/** How long an import URL / fingerprint prompt may wait for the user's click. */
export const PENDING_GACHA_TTL_MS = 15 * 60 * 1000;

export const pendingUrlKey = (userId: string) =>
  `PENDING_GACHA_URL_${userId}`;
export const pendingFingerprintKey = (userId: string) =>
  `PENDING_GACHA_FINGERPRINT_${userId}`;

/**
 * Keeps a short-lived value that may contain an import token. Stored with a
 * TTL and encrypted: it must never sit in the database in the clear, nor for
 * longer than the prompt it belongs to.
 */
export function savePending(
  db: CustomDatabase,
  key: string,
  value: unknown,
): void {
  db.setWithTtl(key, encrypt(JSON.stringify(value)), PENDING_GACHA_TTL_MS);
}

/**
 * Reads a value saved with savePending. Missing, expired, undecryptable, and
 * legacy rows (plain values without a TTL, written before this existed) all
 * read as null, and any row that is still there is deleted.
 */
export async function readPending<T = any>(
  db: CustomDatabase,
  key: string,
): Promise<T | null> {
  const stored = db.getFresh<string>(key);
  if (typeof stored === "string") {
    try {
      return JSON.parse(decrypt(stored)) as T;
    } catch {
      // fall through: unreadable row
    }
  }
  // getFresh already removes an expired row; whatever is left is legacy or broken.
  if ((await db.get(key)) != null) await db.delete(key);
  return null;
}
