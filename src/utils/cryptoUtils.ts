import crypto from "crypto";
import dotenv from "dotenv";

// Make sure .env is loaded before the module-load key check below.
dotenv.config();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Standard for GCM
const AUTH_TAG_LENGTH = 16;

/** Minimum accepted length of ENCRYPTION_KEY (hex-64 keys and passphrases of 16+ chars pass; existing test key is 25 chars). */
export const MIN_ENCRYPTION_KEY_LENGTH = 16;

/**
 * Pure check of an ENCRYPTION_KEY value. Returns null when usable, otherwise a
 * human-readable reason.
 */
export function validateEncryptionKey(
  key: string | undefined | null,
): string | null {
  if (!key) return "ENCRYPTION_KEY environment variable is missing.";
  if (key.length < MIN_ENCRYPTION_KEY_LENGTH)
    return `ENCRYPTION_KEY is too short (need at least ${MIN_ENCRYPTION_KEY_LENGTH} characters).`;
  return null;
}

// In production the bot must refuse to start without a usable key, instead of
// silently storing credentials in plaintext.
if (process.env.NODE_ENV === "production") {
  const problem = validateEncryptionKey(process.env.ENCRYPTION_KEY);
  if (problem) throw new Error(`CRITICAL: ${problem}`);
}

/**
 * Gets the encryption key from environment variables.
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  const problem = validateEncryptionKey(key);
  if (problem || !key) throw new Error(problem ?? "ENCRYPTION_KEY missing.");

  // If it's hex, convert. If it's a string, hash it to 32 bytes for consistency.
  if (/^[0-9a-f]{64}$/i.test(key)) {
    return Buffer.from(key, "hex");
  }

  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Shows only the first and last 4 characters of a secret (for logs / debug
 * output). Values of 8 characters or fewer are fully hidden.
 */
export function maskSecret(value: string): string {
  if (typeof value !== "string" || value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Encrypts sensitive text. Throws when encryption is not possible; callers must
 * never fall back to storing the plaintext.
 */
export function encrypt(text: string): string {
  if (!text) return text;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  // Format: iv:authTag:encryptedData
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

const HEX = /^[0-9a-f]*$/i;

/** True when the value has exactly the shape encrypt() produces. */
function looksEncrypted(parts: string[]): boolean {
  const [iv, tag, data] = parts;
  return (
    parts.length === 3 &&
    iv.length === IV_LENGTH * 2 &&
    tag.length === AUTH_TAG_LENGTH * 2 &&
    data.length > 0 &&
    data.length % 2 === 0 &&
    HEX.test(iv) &&
    HEX.test(tag) &&
    HEX.test(data)
  );
}

/**
 * Decrypts sensitive text.
 * Legacy plaintext (anything not in the encrypted format) is returned
 * unchanged. A value that HAS the encrypted format but fails authentication
 * (wrong key, tampering) throws instead of returning garbage.
 */
export function decrypt(hash: string): string {
  if (!hash || typeof hash !== "string") return hash;

  const parts = hash.split(":");
  if (!looksEncrypted(parts)) {
    // Not our encrypted format: legacy plaintext
    return hash;
  }

  const key = getEncryptionKey();
  const [ivHex, authTagHex, encryptedHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Helper to encrypt sensitive fields of an account object.
 */
export function encryptAccount(account: any): any {
  if (!account) return account;

  const encrypted = { ...account };
  if (encrypted.cookie) encrypted.cookie = encrypt(encrypted.cookie);
  if (encrypted.cred) encrypted.cred = encrypt(encrypted.cred);
  if (encrypted.salt) encrypted.salt = encrypt(encrypted.salt);

  return encrypted;
}

/**
 * Helper to decrypt sensitive fields of an account object.
 */
export function decryptAccount(account: any): any {
  if (!account) return account;

  const decrypted = { ...account };
  if (decrypted.cookie) decrypted.cookie = decrypt(decrypted.cookie);
  if (decrypted.cred) decrypted.cred = decrypt(decrypted.cred);
  if (decrypted.salt) decrypted.salt = decrypt(decrypted.salt);

  return decrypted;
}
