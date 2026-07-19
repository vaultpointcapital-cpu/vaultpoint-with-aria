import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { computeAccountStats } from '@/lib/validations/managed-accounts';
import { ManagedAccountDashboard } from '@/components/managed-accounts/managed-account-dashboard';

export default async function ManagedAccountDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select(
      'id, tier, profit_split_pct, max_drawdown_pct, withdrawal_window_cadence, next_withdrawal_window_date, client_authorization_id, kyc_status, status, starting_capital, current_balance, requires_disclosure_reconfirmation, created_at'
    )
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    notFound();
  }

  const [tradesResult, lastDistributionResult, authorizationResult, distributionsResult] = await Promise.all([
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
    supabase
      .from('profit_distributions')
      .select('id, period_start, period_end, gross_pnl, client_share, vaultpoint_share, status, requested_at, paid_at')
      .eq('managed_account_id', account.id)
      .order('period_end', { ascending: false }),
  ]);

  const trades = tradesResult.data ?? [];
  const stats = computeAccountStats(
    account.starting_capital ?? 0,
    trades,
    lastDistributionResult.data?.period_end ?? null
  );

  return (
    <ManagedAccountDashboard
      account={account}
      stats={stats}
      trades={trades}
      authorization={authorizationResult.data}
      distributions={distributionsResult.data ?? []}
    />
  );
}
