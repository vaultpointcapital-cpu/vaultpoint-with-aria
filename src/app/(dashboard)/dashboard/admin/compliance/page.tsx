import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { computeAccountStats, computeComplianceFlags } from '@/lib/validations/managed-accounts';
import { ComplianceDashboard } from '@/components/managed-accounts/compliance-dashboard';

export default async function CompliancePage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();

  const { data: accounts } = await admin
    .from('managed_accounts')
    .select(
      'id, user_id, tier, status, kyc_status, max_drawdown_pct, client_authorization_id, requires_disclosure_reconfirmation, starting_capital, created_at'
    )
    .order('created_at', { ascending: false });

  const rows = await Promise.all(
    (accounts ?? []).map(async (account) => {
      const [tradesResult, lastDistributionResult, pendingDistributionsResult] = await Promise.all([
        admin.from('managed_trades').select('realized_pnl, closed_at').eq('managed_account_id', account.id),
        admin
          .from('profit_distributions')
          .select('period_end')
          .eq('managed_account_id', account.id)
          .eq('status', 'paid')
          .order('period_end', { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin.from('profit_distributions').select('requested_at').eq('managed_account_id', account.id).eq('status', 'pending'),
      ]);

      const stats = computeAccountStats(
        account.starting_capital ?? 0,
        tradesResult.data ?? [],
        lastDistributionResult.data?.period_end ?? null
      );

      const flags = computeComplianceFlags(account, stats.drawdownPct, pendingDistributionsResult.data ?? []);

      return { account, drawdownPct: stats.drawdownPct, flags };
    })
  );

  return <ComplianceDashboard rows={rows} />;
}
