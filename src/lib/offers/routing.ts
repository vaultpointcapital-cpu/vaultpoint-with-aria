import type { PartnerOffer } from '@/types/database';

/**
 * Region gate for a partner offer. Mirrors src/lib/billing/routing.ts and
 * src/lib/kyc/routing.ts's shape: a pure function over users.country_code.
 *
 * Note (PRD §10.2): regions_allowed is UX only, not a compliance control —
 * the partner (Hantec) gates its own signup by jurisdiction independently.
 * A missing country_code fails closed (offer hidden) rather than assuming
 * availability, since we have no signal either way.
 */
export function isOfferAvailableForRegion(
  offer: Pick<PartnerOffer, 'regions_allowed'>,
  country: string | null | undefined
): boolean {
  if (!country) return false;
  return offer.regions_allowed.includes(country);
}
