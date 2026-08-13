import { createClient } from '@/lib/supabase/server';
import { getKycTierStatus } from '@/lib/kyc/tier-state';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/kyc/status
 *
 * Wallet KYC tier status for the current user — tier, when it was last
 * verified, any in-flight tier-upgrade attempt, and the current tier's
 * deposit/withdrawal limits (kyc_tier_limits). Distinct from any Managed
 * Accounts identity-verification status — see
 * supabase/migrations/20260814000000_add_wallet_kyc_tiering.sql.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  try {
    const status = await getKycTierStatus(authData.user.id);
    return apiSuccess({
      tier: status.tier,
      tierVerifiedAt: status.tierVerifiedAt,
      pendingVerification: status.pendingVerification,
      limits: status.limits,
    });
  } catch (err) {
    console.error('kyc/status error:', err);
    return apiError('INTERNAL_ERROR', 'Could not load KYC status.');
  }
}
