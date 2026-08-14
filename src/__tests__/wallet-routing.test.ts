import { describe, it, expect } from 'vitest';
import {
  resolveWalletProvider,
  walletProviderForCurrency,
  walletProviderToDbEnum,
  CURRENCY_BY_WALLET_PROVIDER,
} from '@/lib/wallet/routing';

describe('resolveWalletProvider', () => {
  it('routes NG to Paystack', () => {
    expect(resolveWalletProvider({ country: 'NG' })).toBe('paystack');
  });

  it('defaults everyone else to Stripe, unlike resolveProvider which routes some to Flutterwave', () => {
    expect(resolveWalletProvider({ country: 'US' })).toBe('stripe');
    expect(resolveWalletProvider({ country: 'GH' })).toBe('stripe');
    expect(resolveWalletProvider({ country: 'KE' })).toBe('stripe');
  });

  it('defaults to Stripe when country is missing', () => {
    expect(resolveWalletProvider({ country: null })).toBe('stripe');
    expect(resolveWalletProvider({ country: undefined })).toBe('stripe');
  });

  it('lets an explicit provider (including crypto) override the country-based default', () => {
    expect(resolveWalletProvider({ country: 'NG', explicitProvider: 'crypto' })).toBe('crypto');
    expect(resolveWalletProvider({ country: 'US', explicitProvider: 'paystack' })).toBe('paystack');
  });
});

describe('walletProviderForCurrency', () => {
  it('maps each supported currency to its rail', () => {
    expect(walletProviderForCurrency('NGN')).toBe('paystack');
    expect(walletProviderForCurrency('USD')).toBe('stripe');
    expect(walletProviderForCurrency('USDT')).toBe('crypto');
  });

  it('returns null for an unsupported currency', () => {
    expect(walletProviderForCurrency('EUR')).toBeNull();
  });

  it('is the exact inverse of CURRENCY_BY_WALLET_PROVIDER', () => {
    for (const [provider, currency] of Object.entries(CURRENCY_BY_WALLET_PROVIDER)) {
      expect(walletProviderForCurrency(currency)).toBe(provider);
    }
  });
});

describe('walletProviderToDbEnum', () => {
  it('maps the app-level "crypto" provider to the DB enum value "web3"', () => {
    expect(walletProviderToDbEnum('crypto')).toBe('web3');
  });

  it('leaves paystack and stripe unchanged', () => {
    expect(walletProviderToDbEnum('paystack')).toBe('paystack');
    expect(walletProviderToDbEnum('stripe')).toBe('stripe');
  });
});
