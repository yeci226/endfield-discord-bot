import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Standard for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Gets the encryption key from environment variables.
 * Should be a 32-byte (256-bit) key.
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    // In dev, we might fallback or error. For security, we should error.
    console.error("CRITICAL: ENCRYPTION_KEY is not set in .env!");
    // For now, if not set, we return a dummy or handle it.
    // Ideally, the bot should refuse to start.
    throw new Error("ENCRYPTION_KEY environment variable is missing.");
  }

  // If it's hex, convert. If it's a string, hash it to 32 bytes for consistency.
  if (/^[0-9a-f]{64}$/i.test(key)) {
    return Buffer.from(key, "hex");
  }

  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypts sensitive text.
 */
export function encrypt(text: string): string {
  if (!text) return text;

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    // Format: iv:authTag:encryptedData
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  } catch (error) {
    console.error("Encryption failed:", error);
    return text; // Fallback or handle differently?
  }
}

/**
 * Decrypts sensitive text.
 * Handles plaintext detection (legacy data).
 */
export function decrypt(hash: string): string {
  if (!hash || typeof hash !== "string") return hash;

  // Basic check: Encrypted data should have two colons
  const parts = hash.split(":");
  if (parts.length !== 3) {
    // Doesn't look like our encrypted format, might be legacy plaintext
    return hash;
  }

  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encryptedHex] = parts;

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    // If decryption fails, it might be legacy text that happened to have colons,
    // or the key changed.
    console.warn(
      "Decryption failed, returning original string. (Check ENCRYPTION_KEY)",
    );
    return hash;
  }
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
