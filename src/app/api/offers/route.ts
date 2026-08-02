import { createClient } from '@/lib/supabase/server';
import { isOfferAvailableForRegion } from '@/lib/offers/routing';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/offers
 *
 * Partner Offers v1. An empty array is a valid, expected response (no
 * active offer for this user's region) — never a 404, per spec.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const { data: profile } = await supabase.from('users').select('country_code').eq('id', authData.user.id).single();

  const { data: offers, error } = await supabase
    .from('partner_offers')
    .select('id, partner_slug, program, account_size_usd, price_from_usd, ref_url, affiliate_code, regions_allowed')
    .eq('active', true);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load partner offers.');
  }

  const available = (offers ?? [])
    .filter((offer) => isOfferAvailableForRegion(offer, profile?.country_code))
    .map((offer) => ({
      id: offer.id,
      partner: offer.partner_slug,
      program: offer.program,
      account_size_usd: offer.account_size_usd,
      price_from_usd: offer.price_from_usd,
      affiliate_code: offer.affiliate_code,
    }));

  return apiSuccess({ offers: available });
}
