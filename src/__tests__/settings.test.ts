import { describe, it, expect } from 'vitest';
import { updateProfileSchema } from '@/lib/validations/settings';

describe('updateProfileSchema', () => {
  it('accepts a full name change alone', () => {
    const result = updateProfileSchema.safeParse({ fullName: 'Ada Lovelace' });
    expect(result.success).toBe(true);
  });

  it('accepts a country code change alone', () => {
    const result = updateProfileSchema.safeParse({ countryCode: 'ng' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.countryCode).toBe('NG'); // uppercased
    }
  });

  it('accepts an empty object (no-op update)', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(true);
  });

  it('treats an empty-string country code as unset, not invalid', () => {
    const result = updateProfileSchema.safeParse({ countryCode: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.countryCode).toBeUndefined();
    }
  });

  it('rejects an empty full name', () => {
    expect(updateProfileSchema.safeParse({ fullName: '' }).success).toBe(false);
  });

  it('rejects a full name over 100 characters', () => {
    expect(updateProfileSchema.safeParse({ fullName: 'a'.repeat(101) }).success).toBe(false);
  });

  it('rejects a country code that is not exactly 2 letters', () => {
    expect(updateProfileSchema.safeParse({ countryCode: 'NGA' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ countryCode: 'N' }).success).toBe(false);
  });

  it('strips unknown fields like subscription_tier rather than erroring', () => {
    const result = updateProfileSchema.safeParse({
      fullName: 'Ada Lovelace',
      subscription_tier: 'elite',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('subscription_tier');
    }
  });
});
