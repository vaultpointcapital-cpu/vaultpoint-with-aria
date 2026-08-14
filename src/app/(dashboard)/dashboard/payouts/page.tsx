import { createClient } from '@/lib/supabase/server';
import { PayoutsTraderView } from '@/components/payouts/payouts-trader-view';

export default async function PayoutsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const [eventsResult, ledgerResult, agreementResult] = await Promise.all([
    supabase.from('withdrawal_events').select('*').eq('user_id', authData.user.id).order('detected_at', { ascending: false }),
    supabase.from('payout_ledger').select('*').eq('user_id', authData.user.id).order('created_at', { ascending: false }),
    supabase.from('prop_payout_agreements').select('*').eq('user_id', authData.user.id).maybeSingle(),
  ]);

  return (
    <PayoutsTraderView
      events={eventsResult.data ?? []}
      ledgerEntries={ledgerResult.data ?? []}
      agreement={agreementResult.data ?? null}
    />
  );
}
