import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, verifyTotpCode, generateTotpCode, generateTotpSecret } from '@/lib/auth/totp';

describe('base32Encode/base32Decode', () => {
  it('round-trips arbitrary bytes', () => {
    const original = Buffer.from('this is a 20-byte!!!', 'ascii');
    expect(base32Decode(base32Encode(original))).toEqual(original);
  });
});

const TOTP_STEP_MS = 30 * 1000;

describe('verifyTotpCode', () => {
  // RFC 6238 Appendix B's own test vector: secret = ASCII
  // "12345678901234567890", SHA1, 30s step, T=59s -> counter 1,
  // 8-digit truncated value 94287082 -> this codebase uses 6 digits,
  // which is the same dynamic truncation's last 6 digits: 287082.
  const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
  const RFC_TIME_MS = 59 * 1000;
  const RFC_CODE = '287082';

  it('matches the RFC 6238 Appendix B test vector', () => {
    const result = verifyTotpCode({ secret: RFC_SECRET, code: RFC_CODE, lastConsumedCounter: null, forTimeMs: RFC_TIME_MS });
    expect(result.valid).toBe(true);
    expect(result.matchedCounter).toBe(1);
  });

  it('rejects a wrong code', () => {
    const result = verifyTotpCode({ secret: RFC_SECRET, code: '000000', lastConsumedCounter: null, forTimeMs: RFC_TIME_MS });
    expect(result.valid).toBe(false);
  });

  it('tolerates one step of clock drift on either side', () => {
    // A realistic "now" (not RFC_TIME_MS's tiny epoch-relative value) so
    // stepping one counter earlier can never go negative.
    const now = Date.now();
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret, now);

    const oneStepEarlier = verifyTotpCode({ secret, code, lastConsumedCounter: null, forTimeMs: now + TOTP_STEP_MS });
    const oneStepLater = verifyTotpCode({ secret, code, lastConsumedCounter: null, forTimeMs: now - TOTP_STEP_MS });
    expect(oneStepEarlier.valid).toBe(true);
    expect(oneStepLater.valid).toBe(true);
  });

  it('rejects a code from more than one step away', () => {
    const farFuture = RFC_TIME_MS + 10 * 30 * 1000;
    const result = verifyTotpCode({ secret: RFC_SECRET, code: RFC_CODE, lastConsumedCounter: null, forTimeMs: farFuture });
    expect(result.valid).toBe(false);
  });

  it('rejects replay of an already-consumed counter', () => {
    const first = verifyTotpCode({ secret: RFC_SECRET, code: RFC_CODE, lastConsumedCounter: null, forTimeMs: RFC_TIME_MS });
    expect(first.valid).toBe(true);

    const replay = verifyTotpCode({
      secret: RFC_SECRET,
      code: RFC_CODE,
      lastConsumedCounter: first.matchedCounter,
      forTimeMs: RFC_TIME_MS,
    });
    expect(replay.valid).toBe(false);
  });
});
