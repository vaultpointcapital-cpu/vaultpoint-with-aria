import crypto from 'crypto';

/**
 * AES-256-GCM encryption for broker API keys/secrets at rest.
 *
 * SECURITY RULES (per dev rule #5 — API keys are sacred):
 * - Encrypt before insert into broker_connections. Never store plaintext.
 * - Decrypt only in memory, only when actively making a broker API call.
 * - NEVER log the decrypted value. NEVER return it to the frontend in any
 *   API response — the UI should only ever show a masked label like
 *   "Bybit •••• 4f2a", never the real key.
 * - ENCRYPTION_KEY must be a 32-byte (64 hex char) value, generated with
 *   `openssl rand -hex 32` and stored only in environment variables.
 *   Rotate it and re-encrypt all rows if it's ever suspected to be exposed.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // bytes
const AUTH_TAG_LENGTH = 16; // bytes

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env.local.'
    );
  }
  if (key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }
  return Buffer.from(key, 'hex');
}

export interface EncryptedPayload {
  ciphertext: string; // hex-encoded
  iv: string; // hex-encoded — store separately per row, never reused
}

/**
 * Encrypts a plaintext string (an API key or secret). Returns ciphertext
 * and the IV used, both hex-encoded for storage in text columns.
 * The auth tag is appended to the ciphertext so a single column can hold
 * everything needed to decrypt.
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Ciphertext + authTag concatenated, since GCM requires both to decrypt.
  const combined = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: combined.toString('hex'),
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypts a payload produced by encrypt(). Throws if the auth tag doesn't
 * verify — meaning the ciphertext was tampered with or the wrong key/IV
 * was used. Never swallow that error silently; a failed decrypt on broker
 * credentials should surface as a sync error, not a default value.
 */
export function decrypt(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const combined = Buffer.from(payload.ciphertext, 'hex');

  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Produces a safe display label for a broker key, e.g. "•••• 4f2a".
 * This — never the real key — is what the UI is allowed to render.
 */
export function maskKey(plaintextKey: string): string {
  if (plaintextKey.length <= 4) return '••••';
  return `•••• ${plaintextKey.slice(-4)}`;
}
