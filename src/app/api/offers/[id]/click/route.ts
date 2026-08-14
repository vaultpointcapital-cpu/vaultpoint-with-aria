import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isOfferAvailableForRegion } from '@/lib/offers/routing';
import { generateStateToken } from '@/lib/offers/tokens';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/offers/:id/click
 *
 * Re-validates region server-side rather than trusting that the client's
 * cached GET /api/offers list is still current (a stale country_code
 * change, or a direct call against an offer id the client never actually
 * saw). Creates or reuses an open (not yet connected/expired) referral row
 * so repeat clicks on the same offer don't fragment attribution across
 * multiple tokens.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const { data: profile } = await supabase.from('users').select('country_code').eq('id', authData.user.id).single();

  const { data: offer } = await supabase
    .from('partner_offers')
    .select('id, ref_url, active, regions_allowed')
    .eq('id', params.id)
    .maybeSingle();

  if (!offer) {
    return apiError('NOT_FOUND', 'This offer does not exist.');
  }
  if (!offer.active) {
    return apiError('VALIDATION_ERROR', 'This offer is no longer available.');
  }
  if (!isOfferAvailableForRegion(offer, profile?.country_code)) {
    return apiError('VALIDATION_ERROR', 'This offer is not available in your region.');
  }

  const serviceClient = createServiceClient();

  const { data: existing } = await serviceClient
    .from('partner_referrals')
    .select('state_token')
    .eq('user_id', authData.user.id)
    .eq('offer_id', offer.id)
    .in('status', ['clicked', 'returned'])
    .order('clicked_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const stateToken = existing?.state_token ?? generateStateToken();

  if (!existing) {
    const { error: insertError } = await serviceClient.from('partner_referrals').insert({
      user_id: authData.user.id,
      offer_id: offer.id,
      state_token: stateToken,
    });
    if (insertError) {
      return apiError('INTERNAL_ERROR', 'Could not start this referral.');
    }
  }

  const separator = offer.ref_url.includes('?') ? '&' : '?';
  return apiSuccess({ redirect_url: `${offer.ref_url}${separator}vp_ref=${stateToken}`, state_token: stateToken });
}
