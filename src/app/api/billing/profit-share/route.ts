import { createClient } from '@/lib/supabase/server';
import {
  computeAttributedProfit,
  getCurrentCalendarMonthToDate,
  listAttributedTrades,
  PROFIT_SHARE_PCT,
} from '@/lib/billing/profit-share';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/billing/profit-share
 * The statement the pre-launch audit found was missing entirely: users
 * had no way to see what they'd be charged before (or after) a
 * profit-share true-up ran. Two parts:
 *
 * - currentPeriod: a LIVE, unbilled preview of the calendar month still
 *   in progress — real trades that have already closed, with the fee
 *   that would apply if today were the last day of the period. This is
 *   never charged from; it exists purely so a user's liability is
 *   visible continuously, well before the actual billing run (which
 *   only ever bills a COMPLETED month — see getPreviousCalendarMonth)
 *   happens.
 * - history: every profit_share_charges row this user has, including
 *   'skipped' periods (attributed_profit <= 0) — the full record, not
 *   just charges that actually cost money.
 *
 * Uses the caller's own RLS-scoped client throughout, not the service
 * client the billing run itself uses — a user viewing their own
 * statement should never see more than RLS would already allow
 * directly.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { periodStart, periodEnd } = getCurrentCalendarMonthToDate();

  const [attributedProfit, trades, historyResult] = await Promise.all([
    computeAttributedProfit(supabase, authData.user.id, periodStart, periodEnd),
    listAttributedTrades(supabase, authData.user.id, periodStart, periodEnd),
    supabase
      .from('profit_share_charges')
      .select(
        'id, period_start, period_end, attributed_profit, fee_amount, fee_currency, payment_provider, status, failure_reason, created_at'
      )
      .eq('user_id', authData.user.id)
      .order('period_end', { ascending: false }),
  ]);

  const projectedFee = attributedProfit > 0 ? Math.round(attributedProfit * (PROFIT_SHARE_PCT / 100) * 100) / 100 : 0;

  return apiSuccess({
    currentPeriod: {
      periodStart,
      periodEnd,
      attributedProfit,
      projectedFee,
      feePct: PROFIT_SHARE_PCT,
      trades,
    },
    history: historyResult.data ?? [],
  });
}
