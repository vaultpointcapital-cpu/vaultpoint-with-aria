import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withdrawRequestSchema } from '@/lib/validations/wallet';
import { checkWalletLimit } from '@/lib/wallet/limits';
import { checkKycTierLimit } from '@/lib/kyc/wallet-tier-limit-check';
import { encrypt } from '@/lib/encryption/broker-keys';
import { initiateStepUp } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/wallet/withdraw/request
 *
 * Step 1 of 2 for a wallet withdrawal. Creates a 'requested' row (inserted
 * directly under the caller's own session — see the insert-own RLS policy
 * in supabase/migrations/20260802000000_add_wallet.sql, same shape as
 * profit_distributions' insert-own policy) and immediately opens a step-up
 * challenge for it. The wallet is not debited here — that only happens in
 * POST /api/wallet/withdraw/confirm, after isStepUpApproved() succeeds,
 * mirroring managed-accounts/[id]/withdraw's "recompute + gate server-side,
 * never trust the client" rule.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = withdrawRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid withdrawal request.', parsed.error.flatten());
  }
  const { amount, currency, destinationType, destinationDetails } = parsed.data;

  const limitCheck = checkWalletLimit(currency, amount);
  if (!limitCheck.ok) {
    return apiError('LIMIT_EXCEEDED', limitCheck.message);
  }

  // KYC tier gate — a tier0/tier1 user is blocked outright
  // ('withdrawals_not_allowed_for_tier' -> KYC_REQUIRED); a tier2 user is
  // still subject to the single/monthly caps -> LIMIT_EXCEEDED.
  const tierCheck = await checkKycTierLimit({ userId: authData.user.id, type: 'withdrawal', amount, currency });
  if (!tierCheck.allowed) {
    return apiError(
      tierCheck.reasonCode === 'withdrawals_not_allowed_for_tier' ? 'KYC_REQUIRED' : 'LIMIT_EXCEEDED',
      tierCheck.message
    );
  }

  const { data: wallet } = await supabase
    .from('wallets')
    .select('balance_cached')
    .eq('user_id', authData.user.id)
    .eq('currency', currency)
    .maybeSingle();

  if (!wallet || Number(wallet.balance_cached) < amount) {
    return apiError('VALIDATION_ERROR', 'Insufficient wallet balance for this withdrawal.');
  }

  // Never store destination details in plaintext — same AES-256-GCM module
  // used for broker API keys, decrypted only in memory at payout time.
  const { ciphertext, iv } = encrypt(JSON.stringify(destinationDetails));

  const { data: withdrawalRequest, error: insertError } = await supabase
    .from('withdrawal_requests')
    .insert({
      user_id: authData.user.id,
      amount,
      currency,
      destination_type: destinationType,
      destination_details_encrypted: ciphertext,
      destination_details_iv: iv,
      status: 'requested',
    })
    .select('id')
    .single();

  if (insertError || !withdrawalRequest) {
    return apiError('INTERNAL_ERROR', 'Could not create your withdrawal request.');
  }

  const stepUp = await initiateStepUp({
    userId: authData.user.id,
    actionType: 'wallet_withdrawal',
    resourceId: withdrawalRequest.id,
  });

  return apiSuccess({ withdrawalRequestId: withdrawalRequest.id, stepUp }, 201);
}
