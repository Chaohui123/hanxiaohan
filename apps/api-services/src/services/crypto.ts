// ============================================================
// Crypto utilities — AES-256-GCM encryption for sensitive data
// Used for store API keys at rest in SQLite
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { logger } from "@onzo/logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

let persistedSalt: Buffer | null = null;

/**
 * Set a persistent salt from external storage (database or env).
 * Must be called once during startup before any encrypt/decrypt.
 */
export function setEncryptionSalt(saltHex: string): void {
  persistedSalt = Buffer.from(saltHex, "hex");
}

/**
 * Load salt from ENCRYPTION_SALT env var.
 * In production, this must be a randomly generated 64-char hex string.
 * In development, a random salt is auto-generated (warning logged).
 */
export function initEncryptionSalt(): Buffer {
  if (persistedSalt) return persistedSalt;

  const saltHex = process.env.ENCRYPTION_SALT;
  if (saltHex) {
    persistedSalt = Buffer.from(saltHex, "hex");
    return persistedSalt;
  }

  // No salt configured — auto-generate one
  const autoSalt = randomBytes(SALT_LENGTH);
  const autoSaltHex = autoSalt.toString("hex");

  if ((process.env.ENV || process.env.NODE_ENV) === "production") {
    const msg = "ENCRYPTION_SALT not set — auto-generated salt will be lost on restart. " +
      `Generated salt (add to .env): ENCRYPTION_SALT=${autoSaltHex}`;
    logger.error(msg);
    throw new Error(msg);
  }

  logger.warn({ generatedSalt: autoSaltHex },
    "ENCRYPTION_SALT not set — auto-generated for dev. Add to .env for persistence."
  );
  persistedSalt = autoSalt;
  return persistedSalt;
}

/**
 * Derive encryption key from ENCRYPTION_KEY + salt.
 * ENCRYPTION_KEY must be set — no fallback.
 */
function deriveKey(): { key: Buffer; salt: Buffer } {
  const masterKey = process.env.ENCRYPTION_KEY;
  if (!masterKey) {
    const msg = "ENCRYPTION_KEY is required for encryption. " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";
    logger.error(msg);
    throw new Error(msg);
  }

  if ((process.env.ENV || process.env.NODE_ENV) === "production" &&
      (masterKey.length < 32 || masterKey === "change_me_to_random_32_chars")) {
    const msg = "ENCRYPTION_KEY is too short or is a placeholder. Production requires a 64-char random hex string.";
    logger.error(msg);
    throw new Error(msg);
  }

  const salt = initEncryptionSalt();
  const key = scryptSync(masterKey, salt, KEY_LENGTH);
  return { key, salt };
}

/**
 * Encrypt plaintext → hex-encoded ciphertext with embedded IV + auth tag + salt.
 * Format: <salt:32bytes><iv:16bytes><authTag:16bytes><ciphertext>
 */
export function encrypt(plaintext: string): string {
  const { key, salt } = deriveKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt + iv + authTag + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString("hex");
}

/**
 * Decrypt hex-encoded ciphertext → plaintext.
 */
export function decrypt(encoded: string): string {
  const packed = Buffer.from(encoded, "hex");

  let offset = 0;
  const salt = packed.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = packed.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = packed.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const encrypted = packed.subarray(offset);

  const masterKey = process.env.ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error("ENCRYPTION_KEY is required for decryption.");
  }

  const key = scryptSync(masterKey, salt, KEY_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Check if a value appears to be encrypted (hex string long enough).
 */
export function isEncrypted(value: string): boolean {
  const minLength = (SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) * 2; // hex encoded
  return /^[0-9a-f]+$/i.test(value) && value.length >= minLength;
}
