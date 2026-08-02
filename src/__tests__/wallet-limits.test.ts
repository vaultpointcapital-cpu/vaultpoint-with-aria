import { describe, it, expect } from 'vitest';
import { checkWalletLimit, WALLET_LIMITS } from '@/lib/wallet/limits';

describe('checkWalletLimit', () => {
  it('accepts an amount within range for a supported currency', () => {
    expect(checkWalletLimit('NGN', 1000)).toEqual({ ok: true });
  });

  it('rejects an amount below the minimum', () => {
    const result = checkWalletLimit('NGN', WALLET_LIMITS.NGN!.min - 1);
    expect(result.ok).toBe(false);
  });

  it('rejects an amount above the maximum', () => {
    const result = checkWalletLimit('USD', WALLET_LIMITS.USD!.max + 1);
    expect(result.ok).toBe(false);
  });

  it('accepts exactly the min and max boundaries', () => {
    expect(checkWalletLimit('USDT', WALLET_LIMITS.USDT!.min)).toEqual({ ok: true });
    expect(checkWalletLimit('USDT', WALLET_LIMITS.USDT!.max)).toEqual({ ok: true });
  });

  it('rejects an unsupported currency', () => {
    const result = checkWalletLimit('EUR', 100);
    expect(result.ok).toBe(false);
  });
});
