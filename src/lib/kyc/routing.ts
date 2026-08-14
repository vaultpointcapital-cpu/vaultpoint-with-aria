import type { KycVendor } from '@/types/database';

/**
 * Mirrors src/lib/billing/routing.ts's resolveProvider — same country
 * signal (users.country_code, already captured at sign-up), same
 * "explicit input wins over the derived default" shape. Spec §2: Nigeria
 * routes to VerifyMe (BVN/NIN/NIMC-connected), everyone else to Onfido
 * (document + biometric, no BVN/NIN relevance outside Nigeria).
 */
export function resolveKycVendor(country: string | null | undefined): KycVendor {
  if (country === 'NG') return 'verifyme';
  return 'onfido';
}
