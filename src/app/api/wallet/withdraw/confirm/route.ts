import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { withdrawConfirmSchema } from '@/lib/validations/wallet';
import { isStepUpApproved } from '@/lib/auth/step-up';
import { decrypt } from '@/lib/encryption/broker-keys';
import { walletProviderForCurrency, walletProviderToDbEnum } from '@/lib/wallet/routing';
import { createPaystackTransferRecipient, initiatePaystackTransfer } from '@/lib/billing/paystack';
import { createStripePayout } from '@/lib/billing/stripe';
import { initiateCryptoPayout } from '@/lib/wallet/web3-adapter';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/wallet/withdraw/confirm
 *
 * Step 2 of 2. Gates on isStepUpApproved() exactly like
 * managed-accounts/[id]/withdraw does, then debits the wallet atomically
 * via wallet_apply_transaction() and attempts the rail-specific payout.
 * The debit and the payout call are deliberately two separate steps, not
 * one transaction — a payout-call failure (including the Stripe/crypto
 * placeholders below, which always throw) leaves the withdrawal debited
 * but the row in 'processing' for manual/ops follow-up, the same
 * self-reported/manual-confirmation pattern managed_accounts withdrawal
 * already ships with (no real payout rail wired there either).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = withdrawConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid withdrawal confirmation.', parsed.error.flatten());
  }
  const { withdrawalRequestId, stepUpApprovalId } = parsed.data;

  const { data: withdrawalRequest } = await supabase
    .from('withdrawal_requests')
    .select('id, user_id, amount, currency, destination_type, destination_details_encrypted, destination_details_iv, status')
    .eq('id', withdrawalRequestId)
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (!withdrawalRequest) {
    return apiError('NOT_FOUND', 'Withdrawal request not found or you do not have access to it.');
  }

  if (withdrawalRequest.status !== 'requested' && withdrawalRequest.status !== 'step_up_pending') {
    return apiError('VALIDATION_ERROR', 'This withdrawal request has already been processed.');
  }

  const stepUpOk = await isStepUpApproved({
    userId: authData.user.id,
    approvalToken: stepUpApprovalId,
    actionType: 'wallet_withdrawal',
    resourceId: withdrawalRequestId,
  });
  if (!stepUpOk) {
    return apiError('VALIDATION_ERROR', 'This withdrawal requires a confirmed step-up approval.');
  }

  const destinationDetails = JSON.parse(
    decrypt({ ciphertext: withdrawalRequest.destination_details_encrypted, iv: withdrawalRequest.destination_details_iv })
  ) as Record<string, string>;

  // Validated before the debit below — a malformed destination should never
  // result in a wallet that's been charged with no way to pay out.
  const rail = walletProviderForCurrency(withdrawalRequest.currency);
  if (!rail) {
    return apiError('INTERNAL_ERROR', `No payout rail configured for currency ${withdrawalRequest.currency}.`);
  }
  if (rail === 'paystack' && (!destinationDetails.accountNumber || !destinationDetails.bankCode)) {
    return apiError('VALIDATION_ERROR', 'accountNumber and bankCode are required for a bank withdrawal.');
  }
  if (rail === 'crypto' && !destinationDetails.address) {
    return apiError('VALIDATION_ERROR', 'A destination address is required for a crypto withdrawal.');
  }

  const serviceClient = createServiceClient();

  // Deterministic idempotency key: a retried confirm call for the same
  // request debits the wallet at most once, same "ON CONFLICT DO NOTHING"
  // guarantee documented on wallet_apply_transaction.
  const { data: rpcResult, error: rpcError } = await serviceClient
    .rpc('wallet_apply_transaction', {
      p_user_id: authData.user.id,
      p_type: 'withdrawal',
      p_amount: withdrawalRequest.amount,
      p_currency: withdrawalRequest.currency,
      p_provider: walletProviderToDbEnum(rail),
      p_provider_reference: `wallet_withdrawal_${withdrawalRequestId}`,
      p_idempotency_key: `wallet_withdrawal_${withdrawalRequestId}`,
      p_metadata: { withdrawal_request_id: withdrawalRequestId },
    })
    .single();

  if (rpcError || !rpcResult) {
    if (rpcError?.code === 'P0004') {
      return apiError('VALIDATION_ERROR', 'Insufficient wallet balance for this withdrawal.');
    }
    return apiError('INTERNAL_ERROR', 'Could not debit your wallet for this withdrawal.');
  }

  let payoutStatus: 'processing' | 'paid' | 'failed' = 'processing';

  // Rail is picked by currency (which rail actually settles that currency —
  // see CURRENCY_BY_WALLET_PROVIDER), not destination_type: destination_type
  // only describes the shape of destinationDetails within that rail.
  // NOTE: 'mobile_money' destinations for NGN currently route through the
  // same Paystack nuban recipient helper as 'bank_account' — Paystack's
  // mobile-money recipient type isn't wired up separately yet.
  try {
    if (rail === 'paystack') {
      const { recipientCode } = await createPaystackTransferRecipient({
        name: destinationDetails.accountName ?? authData.user.email ?? 'VaultPoint user',
        accountNumber: destinationDetails.accountNumber as string,
        bankCode: destinationDetails.bankCode as string,
      });
      await initiatePaystackTransfer({
        amountKobo: Math.round(withdrawalRequest.amount * 100),
        recipientCode,
        reference: `wallet_withdrawal_${withdrawalRequestId}`,
        reason: 'VaultPoint wallet withdrawal',
      });
      payoutStatus = 'processing'; // Paystack transfers finalize asynchronously via webhook.
    } else if (rail === 'crypto') {
      await initiateCryptoPayout({
        userId: authData.user.id,
        amount: withdrawalRequest.amount,
        destinationAddress: destinationDetails.address as string,
        reference: `wallet_withdrawal_${withdrawalRequestId}`,
      });
    } else {
      await createStripePayout({
        amountCents: Math.round(withdrawalRequest.amount * 100),
        currency: withdrawalRequest.currency,
        destinationDetails,
      });
    }
  } catch (err) {
    // Placeholder rails (Stripe payout, crypto payout) always throw today —
    // logged, not surfaced as a hard failure to the user, since the wallet
    // has already been debited and this needs manual/ops follow-up, not a
    // retry loop.
    console.error('wallet/withdraw/confirm payout error:', err);
  }

  const { error: updateError } = await serviceClient
    .from('withdrawal_requests')
    .update({
      wallet_transaction_id: rpcResult.transaction_id,
      step_up_verified_at: new Date().toISOString(),
      status: payoutStatus,
      ...(payoutStatus !== 'processing' ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', withdrawalRequestId);

  if (updateError) {
    return apiError('INTERNAL_ERROR', 'Withdrawal was debited but the request record could not be updated. Contact support.');
  }

  return apiSuccess({ withdrawalRequestId, status: payoutStatus, newBalance: rpcResult.new_balance });
}
