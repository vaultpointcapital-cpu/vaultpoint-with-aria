import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { computeAccountStats, computeComplianceFlags } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/admin/managed-accounts
 * The compliance dashboard's data source — every managed account plus
 * its computed compliance flags (drawdown/reconfirmation/KYC
 * backlog/stale withdrawal/missing authorization). is_admin is checked
 * through the caller's own RLS-scoped session first; only once
 * confirmed does this switch to the service client to read across every
 * user's accounts — regular managed_accounts SELECT RLS only allows a
 * user to see their own rows, which is the wrong scope for this route
 * on purpose.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const admin = createServiceClient();

  const { data: accounts, error } = await admin
    .from('managed_accounts')
    .select(
      'id, user_id, tier, status, kyc_status, max_drawdown_pct, client_authorization_id, requires_disclosure_reconfirmation, starting_capital, created_at'
    )
    .order('created_at', { ascending: false });

  if (error || !accounts) {
    return apiError('INTERNAL_ERROR', 'Could not load managed accounts.');
  }

  const results = await Promise.all(
    accounts.map(async (account) => {
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
        admin
          .from('profit_distributions')
          .select('requested_at')
          .eq('managed_account_id', account.id)
          .eq('status', 'pending'),
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

  return apiSuccess({ accounts: results });
}
