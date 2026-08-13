import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { tier2VerifySchema } from '@/lib/validations/kyc-tier';
import { getKycTierStatus, startTierVerification, applyTierDecision } from '@/lib/kyc/tier-state';
import { getTier2VendorAdapter } from '@/lib/kyc/wallet-tier2-vendor';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/kyc/verify/tier2
 *
 * Tier 2 (BVN/NIN + liveness) is the PRD's "long pole" — the vendor call
 * goes through the swappable adapter in wallet-tier2-vendor.ts, which is a
 * non-production stub in this environment (no real SmileID/Youverify
 * credentials configured). startTierVerification is idempotent against a
 * concurrently in-flight attempt: if one already exists it's reused rather
 * than a second row being created, so a user double-submitting this form
 * never races two vendor calls.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = tier2VerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid Tier 2 verification request.', parsed.error.flatten());
  }

  try {
    const currentStatus = await getKycTierStatus(authData.user.id);
    if (currentStatus.tier === 'tier2') {
      return apiSuccess({ status: 'verified', tier: currentStatus.tier });
    }
    if (currentStatus.tier === 'tier0') {
      return apiError('KYC_REQUIRED', 'Complete Tier 1 verification before starting Tier 2.');
    }

    const adapter = getTier2VendorAdapter();

    const verification = await startTierVerification({
      userId: authData.user.id,
      tier: 'tier2',
      method: 'bvn_nin_liveness',
      provider: adapter.name,
    });

    const result = await adapter.submit({
      userId: authData.user.id,
      bvnOrNin: parsed.data.bvnOrNin,
      livenessSelfieRef: parsed.data.livenessSelfieRef,
    });

    await applyTierDecision({
      verificationId: verification.id,
      decision: result.decision,
      vendorRef: result.vendorRef,
      resultSummary: result.resultSummary,
    });

    const updatedStatus = await getKycTierStatus(authData.user.id);
    return apiSuccess({ status: result.decision, tier: updatedStatus.tier });
  } catch (err) {
    console.error('kyc/verify/tier2 error:', err);
    return apiError('INTERNAL_ERROR', 'Could not complete Tier 2 verification.');
  }
}
