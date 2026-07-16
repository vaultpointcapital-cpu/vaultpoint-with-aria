import { z } from 'zod';

/**
 * Profile fields a user may edit themselves. Deliberately does NOT
 * include subscription_tier — that must only ever be set by the billing
 * webhook (once built) or academy_student (should only ever be set by an
 * internal/admin process, not self-reported — see Card comment on the
 * settings page). Zod strips unknown keys by default, so even a
 * maliciously-crafted request body with extra fields never reaches
 * parsed.data; the API route only ever spreads what's defined here.
 */
export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Name cannot be empty').max(100, 'Name is too long').optional(),
  // Preprocessed so a <select> placeholder's "" value means "not set"
  // instead of failing the length(2) check.
  countryCode: z.preprocess(
    (val) => (val === '' ? undefined : val),
    z.string().trim().toUpperCase().length(2, 'Use a 2-letter country code').optional()
  ),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Biased toward the target markets per the spec (Meir FX Academy's base
 * is Nigeria/West Africa), then a broader set of major countries — not
 * an exhaustive ISO list, which would be a worse UX for the actual user
 * base than a short, relevant one.
 */
export const COUNTRY_OPTIONS: Array<{ code: string; name: string }> = [
  { code: 'NG', name: 'Nigeria' },
  { code: 'GH', name: 'Ghana' },
  { code: 'KE', name: 'Kenya' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'EG', name: 'Egypt' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'IN', name: 'India' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
];
