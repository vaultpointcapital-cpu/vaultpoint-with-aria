import { createClient } from '@/lib/supabase/server';
import { listAttributedTrades } from '@/lib/billing/profit-share';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/billing/profit-share/:chargeId
 * The itemized detail behind one completed profit_share_charges row —
 * the actual trades that made up its attributed_profit total, not just
 * the aggregate figure. RLS's own "select own" policy on
 * profit_share_charges is the real access control here; the
 * .eq('user_id', ...) below is defense in depth, not the only thing
 * stopping a user from viewing someone else's statement.
 */
export async function GET(_request: Request, { params }: { params: { chargeId: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: charge, error: chargeError } = await supabase
    .from('profit_share_charges')
    .select(
      'id, period_start, period_end, attributed_profit, fee_amount, fee_currency, payment_provider, provider_charge_id, status, failure_reason, created_at'
    )
    .eq('id', params.chargeId)
    .eq('user_id', authData.user.id)
    .single();

  if (chargeError || !charge) {
    return apiError('NOT_FOUND', 'Statement not found or you do not have access to it.');
  }

  const trades = await listAttributedTrades(supabase, authData.user.id, charge.period_start, charge.period_end);

  return apiSuccess({ charge, trades });
}
