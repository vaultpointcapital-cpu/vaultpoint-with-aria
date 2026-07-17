import { describe, it, expect } from 'vitest';
import { resolveProvider } from '@/lib/billing/routing';

describe('resolveProvider', () => {
  it('routes NG to Paystack', () => {
    expect(resolveProvider({ country: 'NG' })).toBe('paystack');
  });

  it('routes every other country to Stripe', () => {
    expect(resolveProvider({ country: 'US' })).toBe('stripe');
    expect(resolveProvider({ country: 'GB' })).toBe('stripe');
    expect(resolveProvider({ country: 'ZA' })).toBe('stripe');
  });

  it('defaults to Stripe when country is missing', () => {
    expect(resolveProvider({ country: null })).toBe('stripe');
    expect(resolveProvider({ country: undefined })).toBe('stripe');
  });

  it('lets an explicit preferred_provider override the country-based default', () => {
    expect(resolveProvider({ country: 'NG', preferredProvider: 'stripe' })).toBe('stripe');
    expect(resolveProvider({ country: 'US', preferredProvider: 'paystack' })).toBe('paystack');
  });
});
