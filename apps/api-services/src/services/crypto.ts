// ============================================================
// Crypto utilities — AES-256-GCM encryption for sensitive data
// Used for store API keys at rest in SQLite
// ============================================================

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// Derive encryption key from master API_KEY + salt
// Falls back to a hardcoded seed if API_KEY not set (dev mode)
function deriveKey(): { key: Buffer; salt: Buffer } {
  const masterKey = process.env.API_KEY || process.env.ENCRYPTION_KEY || "onzo-dev-fallback-key-change-in-production";
  const saltHex = process.env.ENCRYPTION_SALT;

  let salt: Buffer;
  if (saltHex) {
    salt = Buffer.from(saltHex, "hex");
  } else {
    // Use a deterministic salt derived from the key itself (NOT secure, but Phase 1)
    salt = Buffer.from("onzo-salt-v1-" + masterKey.slice(0, 16), "utf8").subarray(0, SALT_LENGTH);
    if (salt.length < SALT_LENGTH) {
      salt = Buffer.concat([salt, Buffer.alloc(SALT_LENGTH - salt.length, 0x5a)]);
    }
  }

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

  // Re-derive key with stored salt
  const masterKey = process.env.API_KEY || process.env.ENCRYPTION_KEY || "onzo-dev-fallback-key-change-in-production";
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
