import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  computeAttributedProfit,
  getCurrentCalendarMonthToDate,
  listAttributedTrades,
  PROFIT_SHARE_PCT,
} from '@/lib/billing/profit-share';
import { ProfitShareDashboard } from '@/components/billing/profit-share-dashboard';

/**
 * The statement the pre-launch audit flagged as missing entirely:
 * before this page existed, a profit-share true-up charge happened via
 * a silent, cron-triggered backend job with zero user-facing
 * visibility, before or after. This shows a live, continuously-updated
 * preview of the current (still in-progress, not yet billed) period
 * alongside the full history of completed periods — including
 * 'skipped' ones where attributed profit was zero or negative.
 */
export default async function ProfitShareBillingPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  if (profile?.subscription_tier !== 'elite') {
    redirect('/dashboard/settings');
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

  return (
    <ProfitShareDashboard
      currentPeriod={{ periodStart, periodEnd, attributedProfit, projectedFee, feePct: PROFIT_SHARE_PCT, trades }}
      history={historyResult.data ?? []}
    />
  );
}
