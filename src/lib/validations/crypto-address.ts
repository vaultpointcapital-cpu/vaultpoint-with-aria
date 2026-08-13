/**
 * Chain-specific destination-address validation (spec 4.3.2's "mandatory
 * address validation — checksum validation per chain before submission;
 * never let a malformed address reach the custody API"). Unlike
 * cobo-adapter.ts's vendor-specific guesses, these are open, public,
 * deterministic algorithms — safe to implement with real confidence,
 * not flagged as unverified.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle), not Node's
 * `crypto` module — this file is imported from both a 'use client'
 * component (withdraw-dialog.tsx, for live validation feedback) and a
 * server route (wallet/withdraw/confirm, for the actual enforcement
 * gate), and Node's `crypto` module isn't safe to bundle into a browser
 * client component. Web Crypto is available in both modern browsers and
 * the Next.js server runtime, so one implementation serves both —
 * avoiding a second, potentially-drifting copy of this logic.
 *
 * Only TRON (base58check) is implemented, since 'USDT (TRC-20)' is the
 * only crypto rail this wallet's deposit/withdraw UI offers today
 * (CURRENCY_OPTIONS in deposit-dialog.tsx). EIP-55 checksum validation
 * for EVM chains would need a Keccak-256 implementation this codebase
 * doesn't have as a dependency yet — add one (e.g. js-sha3) if/when an
 * EVM chain is actually offered, rather than installing it speculatively
 * now.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;

  // BigInt(n) calls, not `n`-suffixed literals — this project's tsconfig
  // targets ES2017, which doesn't support BigInt literal syntax even
  // though the BigInt global itself is available via the esnext lib.
  let num = BigInt(0);
  const base = BigInt(58);
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) return null;
    num = num * base + BigInt(index);
  }

  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = num > BigInt(0) ? hexToBytes(hex) : new Uint8Array(0);

  // Leading '1' characters encode leading zero bytes, not captured by
  // the big-integer conversion above.
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== '1') break;
    leadingZeros++;
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Pass the view itself, not data.buffer — for a Uint8Array produced by
  // .subarray(), .buffer is the ENTIRE underlying ArrayBuffer, not just
  // the sliced range, and hashing it silently produces the wrong digest.
  // Cast to BufferSource: TS's DOM lib types SubtleCrypto.digest against
  // ArrayBufferView<ArrayBuffer> specifically, which a plain `new
  // Uint8Array(...)` (typed ArrayBufferLike) doesn't structurally satisfy
  // even though it's valid at runtime.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(digest);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * TRON base58check: 1-byte version prefix (0x41 for mainnet) + 20-byte
 * address + 4-byte checksum (first 4 bytes of double-SHA256 of the
 * preceding 21 bytes). Standard algorithm, same family as Bitcoin's
 * base58check.
 */
export async function isValidTronAddress(address: string): Promise<boolean> {
  if (!address.startsWith('T') || address.length < 25 || address.length > 35) return false;

  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  if (payload[0] !== 0x41) return false;

  const expectedChecksum = (await sha256(await sha256(payload))).subarray(0, 4);
  return bytesEqual(expectedChecksum, checksum);
}

export async function isValidCryptoAddress(chain: string, address: string): Promise<boolean> {
  switch (chain) {
    case 'TRC20':
      return isValidTronAddress(address);
    default:
      // Unknown chain — fail closed rather than silently accept an
      // unvalidated address, same "no chain, no trust" posture as the
      // rest of this feature.
      return false;
  }
}
