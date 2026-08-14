import { describe, it, expect } from 'vitest';
import { isOfferAvailableForRegion } from '@/lib/offers/routing';

const offer = { regions_allowed: ['NG', 'GH', 'KE', 'ZA', 'GB', 'AE'] };

describe('isOfferAvailableForRegion', () => {
  it('allows a country present in regions_allowed', () => {
    expect(isOfferAvailableForRegion(offer, 'NG')).toBe(true);
  });

  it('blocks a country absent from regions_allowed', () => {
    expect(isOfferAvailableForRegion(offer, 'US')).toBe(false);
  });

  it('fails closed when country_code is missing', () => {
    expect(isOfferAvailableForRegion(offer, null)).toBe(false);
    expect(isOfferAvailableForRegion(offer, undefined)).toBe(false);
  });
});
