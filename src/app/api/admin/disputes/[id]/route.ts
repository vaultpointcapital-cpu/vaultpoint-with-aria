import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/admin/disputes/:id
 *
 * Full dispute record plus two read-only context panels:
 *  - linkedEvents: resolves dispute.linked_event_ids against
 *    value_ledger_events. Per the escalation spec's own dependency (a
 *    "Value Ledger" fee-attribution/net-return event trail) not actually
 *    existing yet — see 20260816000000_add_dispute_escalation_policy.sql's
 *    header — this will legitimately be an empty array for most disputes
 *    at launch, not a bug in this route.
 *  - relatedRecords: the REAL, already-populated managed-account
 *    financial history for whichever account this dispute is linked to
 *    (managed_trades + profit_distributions for a custodial
 *    managed_accounts dispute, managed_account_audit_log for a Managed
 *    Trader Pathway managed_sub_accounts dispute) — pulled directly, not
 *    through linked_event_ids, so this tool is actually useful for
 *    resolving today's real disputes.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();

  const { data: dispute, error } = await admin.from('disputes').select('*').eq('id', params.id).maybeSingle();
  if (error || !dispute) return apiError('NOT_FOUND', 'Dispute not found.');

  const [escalationChain, linkedEvents, relatedTrades, relatedDistributions, relatedAuditLog] = await Promise.all([
    admin
      .from('disputes')
      .select('*')
      .or(`id.eq.${dispute.parent_dispute_id ?? dispute.id},parent_dispute_id.eq.${dispute.id}`)
      .order('opened_at', { ascending: true }),
    dispute.linked_event_ids.length > 0
      ? admin.from('value_ledger_events').select('*').in('id', dispute.linked_event_ids)
      : Promise.resolve({ data: [] }),
    dispute.managed_account_id
      ? admin
          .from('managed_trades')
          .select('*')
          .eq('managed_account_id', dispute.managed_account_id)
          .order('opened_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),
    dispute.managed_account_id
      ? admin
          .from('profit_distributions')
          .select('*')
          .eq('managed_account_id', dispute.managed_account_id)
          .order('period_end', { ascending: false })
          .limit(24)
      : Promise.resolve({ data: [] }),
    dispute.managed_sub_account_id
      ? admin
          .from('managed_account_audit_log')
          .select('*')
          .eq('sub_account_id', dispute.managed_sub_account_id)
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  return apiSuccess({
    dispute,
    escalationChain: escalationChain.data ?? [],
    linkedEvents: linkedEvents.data ?? [],
    relatedRecords: {
      trades: relatedTrades.data ?? [],
      distributions: relatedDistributions.data ?? [],
      auditLog: relatedAuditLog.data ?? [],
    },
  });
}
