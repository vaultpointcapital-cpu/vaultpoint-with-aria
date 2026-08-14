import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, maskKey } from '@/lib/encryption/broker-keys';

const TEST_KEY = 'a'.repeat(64);

describe('encrypt/decrypt round-trip', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  it('round-trips a plaintext value', () => {
    const payload = encrypt('my-secret-api-key');
    expect(decrypt(payload)).toBe('my-secret-api-key');
  });

  it('generates a fresh, distinct IV on every call — never reused across fields', () => {
    // This is the actual property the encryption_iv reconciliation depends
    // on: src/app/api/brokers/route.ts calls encrypt() once per credential
    // field (key, secret, passphrase) and stores each IV in its own
    // column. If encrypt() ever reused an IV across calls, two ciphertexts
    // under the same key would share a nonce — a real AES-GCM break, not
    // a cosmetic issue.
    const a = encrypt('api-key-value');
    const b = encrypt('api-secret-value');
    const c = encrypt('api-passphrase-value');

    expect(a.iv).not.toBe(b.iv);
    expect(a.iv).not.toBe(c.iv);
    expect(b.iv).not.toBe(c.iv);
  });

  it('rejects decryption when a ciphertext is paired with the wrong IV', () => {
    // Proves the per-field IV columns actually matter, not just exist:
    // if api_key_iv and api_secret_iv were accidentally cross-wired
    // somewhere (Node insert, Python read, or a hand-written migration/
    // seed script), decryption must fail loudly, never silently return
    // wrong-but-plausible plaintext.
    const key = encrypt('api-key-value');
    const secret = encrypt('api-secret-value');

    expect(() => decrypt({ ciphertext: key.ciphertext, iv: secret.iv })).toThrow();
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encrypt('my-secret-api-key');
    const tampered = { ciphertext: '00' + payload.ciphertext.slice(2), iv: payload.iv };
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe('maskKey', () => {
  it('shows only the last 4 characters', () => {
    expect(maskKey('sk_live_abcd1234wxyz')).toBe('•••• wxyz');
  });

  it('fully masks a key of 4 characters or fewer', () => {
    expect(maskKey('abcd')).toBe('••••');
    expect(maskKey('ab')).toBe('••••');
  });
});
