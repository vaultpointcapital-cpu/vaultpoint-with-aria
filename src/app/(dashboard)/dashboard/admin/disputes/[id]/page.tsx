import { notFound, redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { DisputeDetail } from '@/components/disputes/dispute-detail';

export default async function DisputeDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();

  const { data: dispute } = await admin.from('disputes').select('*').eq('id', params.id).maybeSingle();
  if (!dispute) {
    notFound();
  }

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

  return (
    <DisputeDetail
      dispute={dispute}
      escalationChain={escalationChain.data ?? []}
      linkedEvents={linkedEvents.data ?? []}
      relatedRecords={{
        trades: relatedTrades.data ?? [],
        distributions: relatedDistributions.data ?? [],
        auditLog: relatedAuditLog.data ?? [],
      }}
    />
  );
}
