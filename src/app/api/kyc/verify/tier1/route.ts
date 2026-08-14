import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { tier1VerifySchema } from '@/lib/validations/kyc-tier';
import { getKycTierStatus, startTierVerification, applyTierDecision } from '@/lib/kyc/tier-state';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/kyc/verify/tier1
 *
 * Tier 1 (phone + email + basic ID capture) is instant/near-instant per
 * PRD §9 — no vendor call, no manual review. Format-checks the submission
 * and immediately marks the attempt verified, mirroring the PRD's own
 * description of this tier rather than routing through a real vendor
 * (that's Tier 2 — see wallet-tier2-vendor.ts).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = tier1VerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid Tier 1 verification request.', parsed.error.flatten());
  }

  try {
    const currentStatus = await getKycTierStatus(authData.user.id);
    if (currentStatus.tier !== 'tier0') {
      return apiSuccess({ tier: currentStatus.tier, tierVerifiedAt: currentStatus.tierVerifiedAt });
    }

    const verification = await startTierVerification({
      userId: authData.user.id,
      tier: 'tier1',
      method: 'phone_email',
      provider: 'internal',
    });

    // Scrubbed summary only — no raw phone/email/ID number persisted here,
    // same discipline as public.kyc_verifications.result_summary.
    await applyTierDecision({
      verificationId: verification.id,
      decision: 'verified',
      resultSummary: { checks_passed: ['phone_email_format', 'id_capture_present'], reasons: [] },
    });

    const updatedStatus = await getKycTierStatus(authData.user.id);
    return apiSuccess({ tier: updatedStatus.tier, tierVerifiedAt: updatedStatus.tierVerifiedAt });
  } catch (err) {
    console.error('kyc/verify/tier1 error:', err);
    return apiError('INTERNAL_ERROR', 'Could not complete Tier 1 verification.');
  }
}
