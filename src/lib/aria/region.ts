export type AriaRegion = 'NG' | 'GB' | 'US' | 'EU' | 'OTHER';

// The 27 EU member states — same "not exhaustive by design, add as the
// product actually launches there" spirit as billing/routing.ts's
// FLUTTERWAVE_COUNTRIES, though EU membership itself is a closed list
// rather than a growing market list.
const EU_COUNTRY_CODES = new Set([
  'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PT', 'IE', 'AT', 'FI', 'GR', 'LU', 'SE', 'DK',
  'PL', 'CZ', 'HU', 'RO', 'BG', 'HR', 'SK', 'SI', 'EE', 'LV', 'LT', 'CY', 'MT',
]);

/**
 * Derived from country_code, same pattern as billing/routing.ts's
 * resolveProvider and kyc/routing.ts's resolveKycVendor — there is no
 * `region` column on `users` (confirmed against the schema), and this
 * mirrors those two rather than introducing a third derivation style.
 */
export function resolveAriaComplianceRegion(countryCode: string | null | undefined): AriaRegion {
  if (countryCode === 'NG') return 'NG';
  if (countryCode === 'GB') return 'GB';
  if (countryCode === 'US') return 'US';
  if (countryCode && EU_COUNTRY_CODES.has(countryCode)) return 'EU';
  return 'OTHER';
}

// Informational facts for Aria to weave in — NOT a substitute for real
// legal/compliance review before launch. Same provisional-content
// treatment as the Money & Currency Layer's NGN dual-rate flag: shipped
// because the alternative (nothing) is worse, but flagged as needing
// sign-off, not presented as reviewed legal copy.
const REGION_NOTES: Record<AriaRegion, readonly string[]> = {
  NG: [
    'Nigerian crypto policy has shifted materially in the past (CBN restrictions, later relaxed) — treat crypto-related regulatory statements as time-sensitive, not settled.',
    "VaultPoint's NGN figures may reflect an official or parallel-market rate depending on the data source — the two can diverge significantly; do not treat them as interchangeable without saying which one a figure uses.",
  ],
  GB: [
    'Crypto assets held through VaultPoint are not covered by the FCA or FSCS deposit protection scheme.',
  ],
  US: [
    'Crypto assets held through VaultPoint are not FDIC-insured and are not covered by SIPC.',
  ],
  EU: [
    'Crypto assets held through VaultPoint are not covered by an EU/EEA deposit guarantee scheme.',
  ],
  OTHER: [
    'No region-specific deposit or investor protection scheme is known to apply to this account.',
  ],
};

export function getRegionNotes(region: AriaRegion): readonly string[] {
  return REGION_NOTES[region];
}

// Best-effort approximation only — there is no timezone column on
// `users` and no per-user timezone data source exists anywhere in this
// codebase. A single zone per country is lossy for large countries
// (the US spans six) — flagged the same way this session flagged the
// MetaTrader auth-error heuristic: shipped because it's directionally
// useful prompt context, not because it's precise. A real per-user
// timezone needs an onboarding field, out of scope here.
const APPROX_TIMEZONES: Record<string, string> = {
  NG: 'Africa/Lagos',
  GB: 'Europe/London',
  US: 'America/New_York',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  GH: 'Africa/Accra',
  KE: 'Africa/Nairobi',
  ZA: 'Africa/Johannesburg',
};

export function resolveApproxTimezone(countryCode: string | null | undefined): string {
  if (countryCode && APPROX_TIMEZONES[countryCode]) return APPROX_TIMEZONES[countryCode];
  return 'UTC';
}
