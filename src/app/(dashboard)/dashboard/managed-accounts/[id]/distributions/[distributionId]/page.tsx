import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { StatementView } from '@/components/managed-accounts/statement-view';

/**
 * The spec's Section 3 step 6 calls for a generated PDF statement,
 * "stored and available in-app." No PDF-generation library or file
 * storage integration exists anywhere in this codebase (see
 * managed-accounts.ts's other flagged gaps), so this is a real,
 * server-rendered, print-friendly statement page instead — genuinely
 * viewable and downloadable via the browser's own Print-to-PDF, not a
 * stub. A literal stored .pdf blob (statement_pdf_url on
 * profit_distributions is still null) is a follow-up integration, not
 * silently claimed as done here.
 */
export default async function DistributionStatementPage({
  params,
}: {
  params: { id: string; distributionId: string };
}) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, tier, broker, user_id')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    notFound();
  }

  const [{ data: distribution }, { data: profile }] = await Promise.all([
    supabase
      .from('profit_distributions')
      .select(
        'id, period_start, period_end, gross_pnl, client_share, vaultpoint_share, payout_method, status, requested_at, confirmed_at, paid_at'
      )
      .eq('id', params.distributionId)
      .eq('managed_account_id', account.id)
      .single(),
    supabase.from('users').select('full_name').eq('id', authData.user.id).single(),
  ]);

  if (!distribution) {
    notFound();
  }

  return (
    <StatementView
      accountId={account.id}
      tier={account.tier}
      clientName={profile?.full_name ?? null}
      clientEmail={authData.user.email ?? ''}
      distribution={distribution}
    />
  );
}
