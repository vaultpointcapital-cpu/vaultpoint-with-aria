import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { computeAccountStats, computeDistributionBreakdown } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/managed-accounts/:id/withdraw/preview?type=profit|full_closure
 * Step 3 of the withdrawal flow — the "Gross P&L -> Your share ->
 * VaultPoint's share -> Net to you" breakdown the client must see before
 * confirming. Read-only: computes from current data but writes nothing,
 * so a client can back out of the withdrawal screen with no residue.
 *
 * type=profit previews withdrawing only the P&L accrued since the last
 * distribution (gross_pnl is split per the tier's profit_split_pct).
 * type=full_closure previews withdrawing the entire current balance and
 * closing the account — VaultPoint only ever splits the PROFIT portion
 * of that balance, never the returned principal (see
 * computeDistributionBreakdown's comment); this is the spec's own
 * "principal must still be withdrawable, even mid-drawdown" edge case,
 * not a policy call made here.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const withdrawalType = request.nextUrl.searchParams.get('type');
  if (withdrawalType !== 'profit' && withdrawalType !== 'full_closure') {
    return apiError('VALIDATION_ERROR', 'type must be "profit" or "full_closure".');
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, status, starting_capital, profit_split_pct, withdrawal_window_cadence, next_withdrawal_window_date')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  if (account.status !== 'active') {
    return apiError('VALIDATION_ERROR', 'Only an active managed account can request a withdrawal.');
  }

  if (
    account.withdrawal_window_cadence !== 'on_demand' &&
    account.next_withdrawal_window_date &&
    new Date(account.next_withdrawal_window_date) > new Date()
  ) {
    return apiError(
      'VALIDATION_ERROR',
      `The next withdrawal window for this account opens ${account.next_withdrawal_window_date}.`
    );
  }

  const [tradesResult, lastDistributionResult] = await Promise.all([
    supabase
      .from('managed_trades')
      .select('realized_pnl, closed_at')
      .eq('managed_account_id', account.id),
    supabase
      .from('profit_distributions')
      .select('period_end')
      .eq('managed_account_id', account.id)
      .eq('status', 'paid')
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const trades = tradesResult.data ?? [];
  const periodStart = lastDistributionResult.data?.period_end ?? null;
  const stats = computeAccountStats(account.starting_capital ?? 0, trades, periodStart);

  if (withdrawalType === 'profit') {
    if (stats.pnlSinceLastDistribution <= 0) {
      return apiError('VALIDATION_ERROR', 'There is no profit available to withdraw since your last distribution.');
    }

    const breakdown = computeDistributionBreakdown(stats.pnlSinceLastDistribution, account.profit_split_pct);
    return apiSuccess({ withdrawalType, breakdown, periodStart, periodEnd: new Date().toISOString().slice(0, 10) });
  }

  // full_closure: split only the undistributed-profit portion of the
  // current balance. netToClient is always currentBalance minus
  // VaultPoint's cut — computed this way (not principal + clientShare)
  // so a loss since the last distribution (pnlSinceLastDistribution < 0,
  // vaultpointShare 0) isn't subtracted a second time on top of the
  // balance that already reflects it. `principal` is a display-only
  // label for "the part of the balance that isn't this period's
  // undistributed profit."
  const breakdown = computeDistributionBreakdown(stats.pnlSinceLastDistribution, account.profit_split_pct);
  const principal = stats.currentBalance - Math.max(0, stats.pnlSinceLastDistribution);
  const netToClient = stats.currentBalance - breakdown.vaultpointShare;

  return apiSuccess({
    withdrawalType,
    breakdown,
    principal,
    netToClient,
    periodStart,
    periodEnd: new Date().toISOString().slice(0, 10),
  });
}
