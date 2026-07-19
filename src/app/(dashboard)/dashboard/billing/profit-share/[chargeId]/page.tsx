import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { listAttributedTrades } from '@/lib/billing/profit-share';
import { ProfitShareStatement } from '@/components/billing/profit-share-statement';

export default async function ProfitShareStatementPage({ params }: { params: { chargeId: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const { data: charge } = await supabase
    .from('profit_share_charges')
    .select(
      'id, period_start, period_end, attributed_profit, fee_amount, fee_currency, payment_provider, provider_charge_id, status, failure_reason, created_at'
    )
    .eq('id', params.chargeId)
    .eq('user_id', authData.user.id)
    .single();

  if (!charge) {
    notFound();
  }

  const trades = await listAttributedTrades(supabase, authData.user.id, charge.period_start, charge.period_end);

  return <ProfitShareStatement charge={charge} trades={trades} />;
}
