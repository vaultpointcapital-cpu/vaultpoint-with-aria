import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { chargeStripeProfitShare } from '@/lib/billing/profit-share';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/payout-ledger/:id/charge-fiat
 *
 * Option C (fiat fallback), Stripe-only — Paystack has no recurring-charge
 * capability in this codebase at all (no authorization_code flow), so
 * this route only ever attempts Stripe, reusing chargeStripeProfitShare's
 * exact off-session-charge-against-default-payment-method pattern
 * (src/lib/billing/profit-share.ts). Requires the trader to already have
 * an active Stripe subscription with a card on file — there is no
 * separate "collect a card for someone with no subscription" flow
 * anywhere in this codebase (no SetupIntent code exists). On failure,
 * this fails closed: status stays whatever it was, no invoicing/netting
 * fallback is built (spec's own "out of scope: automated dispute
 * resolution" — this is the same class of gap, left for manual ops
 * follow-up, not silently handled).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();

  const { data: entry } = await admin.from('payout_ledger').select('*').eq('id', params.id).maybeSingle();
  if (!entry) return apiError('NOT_FOUND', 'Payout ledger entry not found.');
  if (entry.collection_method !== 'fiat_card_charge') {
    return apiError('VALIDATION_ERROR', 'This action only applies to fiat_card_charge payouts.');
  }
  if (entry.status !== 'pending') {
    return apiError('VALIDATION_ERROR', `Cannot charge for status "${entry.status}".`);
  }

  const { data: subscription } = await admin
    .from('subscriptions')
    .select('provider_customer_id, payment_provider')
    .eq('user_id', entry.user_id)
    .eq('payment_provider', 'stripe')
    .maybeSingle();

  if (!subscription?.provider_customer_id) {
    return apiError(
      'VALIDATION_ERROR',
      'No Stripe customer on file for this trader — fall back to invoicing or netting per agreement terms.'
    );
  }

  try {
    const { providerChargeId } = await chargeStripeProfitShare({
      customerId: subscription.provider_customer_id,
      amountUsd: entry.vaultpoint_amount,
    });

    const { data: updated, error } = await admin
      .from('payout_ledger')
      .update({ status: 'collected', collected_at: new Date().toISOString() })
      .eq('id', entry.id)
      .select('*')
      .single();

    if (error || !updated) return apiError('INTERNAL_ERROR', 'Charge succeeded but the ledger could not be updated.');

    return apiSuccess({ entry: updated, providerChargeId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from('payout_ledger').update({ status: 'failed' }).eq('id', entry.id);
    return apiError('PAYMENT_ERROR', `Stripe charge failed: ${message}. Fall back to invoicing/netting per agreement terms.`);
  }
}
