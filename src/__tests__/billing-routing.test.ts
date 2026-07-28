import { describe, it, expect } from 'vitest';
import { resolveProvider } from '@/lib/billing/routing';

describe('resolveProvider', () => {
  it('routes NG to Paystack', () => {
    expect(resolveProvider({ country: 'NG' })).toBe('paystack');
  });

  it('routes non-African countries to Stripe', () => {
    expect(resolveProvider({ country: 'US' })).toBe('stripe');
    expect(resolveProvider({ country: 'GB' })).toBe('stripe');
  });

  it('routes other African markets to Flutterwave', () => {
    expect(resolveProvider({ country: 'GH' })).toBe('flutterwave');
    expect(resolveProvider({ country: 'KE' })).toBe('flutterwave');
    expect(resolveProvider({ country: 'ZA' })).toBe('flutterwave');
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
