import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { computeAccountStats } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/managed-accounts/:id
 * The Client Dashboard's data source: account details, computed
 * balance/P&L/drawdown stats (see computeAccountStats), the read-only
 * trade log, and links to the client's disclosure/authorization
 * records. Deliberately returns only what the dashboard's own
 * acceptance criteria calls for — no projected/guaranteed-return
 * figures, no "vs market" comparison data, because those must never be
 * shown per the spec's explicit exclusion list; not omitting them here
 * would just move the guardrail into the UI layer where it's one
 * careless render away from being violated.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: account, error: accountError } = await supabase
    .from('managed_accounts')
    .select(
      'id, tier, profit_split_pct, max_drawdown_pct, withdrawal_window_cadence, next_withdrawal_window_date, client_authorization_id, kyc_status, status, starting_capital, current_balance, requires_disclosure_reconfirmation, created_at'
    )
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (accountError || !account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  const [tradesResult, lastDistributionResult, authorizationResult] = await Promise.all([
    supabase
      .from('managed_trades')
      .select('symbol, side, size, entry_price, exit_price, realized_pnl, opened_at, closed_at')
      .eq('managed_account_id', account.id)
      .order('opened_at', { ascending: false }),
    supabase
      .from('profit_distributions')
      .select('period_end')
      .eq('managed_account_id', account.id)
      .eq('status', 'paid')
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle(),
    account.client_authorization_id
      ? supabase
          .from('client_authorizations')
          .select('id, document_version, document_url, signed_at')
          .eq('id', account.client_authorization_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const trades = tradesResult.data ?? [];
  const stats = computeAccountStats(
    account.starting_capital ?? 0,
    trades,
    lastDistributionResult.data?.period_end ?? null
  );

  return apiSuccess({
    account,
    stats,
    trades,
    authorization: authorizationResult.data,
  });
}
