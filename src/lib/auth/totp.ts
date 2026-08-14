import crypto from 'crypto';

/**
 * Step-Up Auth Ticket 3 — standard TOTP (RFC 6238, built on RFC 4226's
 * HOTP), hand-rolled: no otplib/speakeasy/otpauth package exists in this
 * project (checked package-lock.json — not even transitively, unlike
 * `jose` for Ticket 2's JWTs). HMAC-SHA1 + dynamic truncation is the
 * whole algorithm; this is verified against RFC 6238 Appendix B's own
 * test vector in src/__tests__/totp.test.ts, not just self-consistent
 * with itself.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** ±1 step either side of "now" tolerates clock drift between server and authenticator app. */
const TOTP_WINDOW = 1;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP. Returns the raw 31-bit dynamically-truncated integer, not yet mod'd to TOTP_DIGITS. */
function hotpRaw(secret: Buffer, counter: number): number {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return (
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  );
}

function hotpCode(secret: Buffer, counter: number): string {
  const modulus = 10 ** TOTP_DIGITS;
  return (hotpRaw(secret, counter) % modulus).toString().padStart(TOTP_DIGITS, '0');
}

export function currentTotpCounter(forTimeMs: number = Date.now()): number {
  return Math.floor(forTimeMs / 1000 / TOTP_STEP_SECONDS);
}

/** Not used by verification (which never needs to generate a code) — exposed for tests. */
export function generateTotpCode(secret: Buffer, forTimeMs: number = Date.now()): string {
  return hotpCode(secret, currentTotpCounter(forTimeMs));
}

export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(20); // 160 bits — the size RFC 4226 itself recommends for HMAC-SHA1
}

export function buildOtpauthUri(params: { secret: Buffer; accountEmail: string }): string {
  const label = encodeURIComponent(`VaultPoint:${params.accountEmail}`);
  const secretBase32 = base32Encode(params.secret);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=VaultPoint&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export interface VerifyTotpResult {
  valid: boolean;
  /** The time-step counter the match was found at — the caller must persist this as the new last_consumed_counter to block replay. */
  matchedCounter: number | null;
}

/**
 * Checks `code` against every step in [-TOTP_WINDOW, +TOTP_WINDOW] around
 * now, rejecting any step at or before `lastConsumedCounter` — that's
 * what stops the exact same code (or an earlier one within the window)
 * being replayed once it's already been used.
 */
export function verifyTotpCode(params: {
  secret: Buffer;
  code: string;
  lastConsumedCounter: number | null;
  forTimeMs?: number;
}): VerifyTotpResult {
  const nowCounter = currentTotpCounter(params.forTimeMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const counter = nowCounter + delta;
    if (counter < 0) continue;
    if (params.lastConsumedCounter !== null && counter <= params.lastConsumedCounter) continue;
    const expected = hotpCode(params.secret, counter);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(params.code, 'utf8');
    if (
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return { valid: true, matchedCounter: counter };
    }
  }
  return { valid: false, matchedCounter: null };
}
