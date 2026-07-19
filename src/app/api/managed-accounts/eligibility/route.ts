import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isEligibleForManagedTier, MANAGED_TIER_MIN_SUBSCRIPTION } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { ManagedTier } from '@/types/database';

const VALID_TIERS: ManagedTier[] = ['bronze', 'silver', 'gold'];

/**
 * GET /api/managed-accounts/eligibility?tier=silver
 * Step 1 of onboarding. A Pro/Elite-only check today (see
 * MANAGED_TIER_MIN_SUBSCRIPTION) — an ineligible response is expected
 * to route the client to the subscription upgrade flow, kept separate
 * per the spec's own Section 6 constraint, not folded into this route.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const tier = request.nextUrl.searchParams.get('tier') as ManagedTier | null;
  if (!tier || !VALID_TIERS.includes(tier)) {
    return apiError('VALIDATION_ERROR', 'A valid tier query param is required (bronze, silver, or gold).');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  const subscriptionTier = profile?.subscription_tier ?? 'free';
  const eligible = isEligibleForManagedTier(subscriptionTier, tier);

  return apiSuccess({
    eligible,
    subscriptionTier,
    requiredSubscriptionTier: MANAGED_TIER_MIN_SUBSCRIPTION[tier],
  });
}
