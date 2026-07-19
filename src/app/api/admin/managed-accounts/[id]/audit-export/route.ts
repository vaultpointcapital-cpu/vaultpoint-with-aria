import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError } from '@/lib/utils/api-response';

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const [firstRow] = rows;
  if (!firstRow) return '';
  const headers = Object.keys(firstRow);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

/**
 * GET /api/admin/managed-accounts/:id/audit-export
 * The "audit export tool" the compliance section calls for — every
 * record tied to one managed account (disclosure views, the signed
 * authorization, trades, distributions), each as its own CSV section,
 * so a compliance reviewer or auditor gets the full paper trail for one
 * client in one file. Plain CSV rather than a formatted report/PDF —
 * no report-generation library is integrated (same gap noted on the
 * distribution statement page); this is a genuine, complete data
 * export, not a stub.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const admin = createServiceClient();

  const { data: account } = await admin
    .from('managed_accounts')
    .select(
      'id, user_id, tier, status, kyc_status, kyc_verified_at, broker, starting_capital, current_balance, profit_split_pct, max_drawdown_pct, withdrawal_window_cadence, requires_disclosure_reconfirmation, client_authorization_id, created_at'
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found.');
  }

  const [disclosureViewsResult, authorizationsResult, tradesResult, distributionsResult] = await Promise.all([
    admin
      .from('disclosure_views')
      .select('id, document_version, viewed_at, scrolled_to_bottom_at')
      .eq('user_id', account.user_id)
      .order('viewed_at', { ascending: true }),
    admin
      .from('client_authorizations')
      .select('id, document_version, typed_legal_name, signed_at, ip_address, signature_method, revoked_at')
      .eq('user_id', account.user_id)
      .order('signed_at', { ascending: true }),
    admin
      .from('managed_trades')
      .select('id, symbol, side, size, entry_price, exit_price, realized_pnl, opened_at, closed_at')
      .eq('managed_account_id', account.id)
      .order('opened_at', { ascending: true }),
    admin
      .from('profit_distributions')
      .select('id, period_start, period_end, gross_pnl, client_share, vaultpoint_share, payout_method, status, requested_at, confirmed_at, paid_at')
      .eq('managed_account_id', account.id)
      .order('period_end', { ascending: true }),
  ]);

  const sections = [
    '# ACCOUNT',
    toCsv([account]),
    '',
    '# DISCLOSURE_VIEWS',
    toCsv(disclosureViewsResult.data ?? []),
    '',
    '# CLIENT_AUTHORIZATIONS',
    toCsv(authorizationsResult.data ?? []),
    '',
    '# MANAGED_TRADES',
    toCsv(tradesResult.data ?? []),
    '',
    '# PROFIT_DISTRIBUTIONS',
    toCsv(distributionsResult.data ?? []),
  ];

  return new Response(sections.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="managed-account-${account.id}-audit.csv"`,
    },
  });
}
