import { createClient } from '@/lib/supabase/server';
import { isKycVerifiedForAccount } from '@/lib/kyc/verification-state';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/:id/advance-to-funding
 *
 * Spec §6 — the server-side KYC gate. The wizard's "I've been notified
 * my KYC is verified — continue to funding" button
 * (src/components/managed-accounts/onboarding-wizard.tsx) used to be a
 * pure client-side setStep('funding') with no server check at all. The
 * money-moving action itself (POST /api/managed-accounts/:id/fund) was
 * already gated server-side on kyc_status plus the
 * managed_accounts_active_requires_kyc DB CHECK constraint, so an
 * unverified client could never actually complete funding — but they
 * could reach and interact with the funding form first, which this
 * closes.
 *
 * Reads kyc_verifications directly (via isKycVerifiedForAccount), not
 * just the managed_accounts.kyc_status denormalized flag, so an expired
 * verification can't keep this gate open past its re-verification
 * horizon (spec §9).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  const verified = await isKycVerifiedForAccount(params.id);
  if (!verified) {
    return apiError('KYC_REQUIRED', 'KYC is not verified for this account yet.');
  }

  return apiSuccess({ canAdvance: true });
}
