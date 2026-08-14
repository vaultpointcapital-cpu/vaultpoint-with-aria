import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { WithdrawForm } from '@/components/managed-accounts/withdraw-form';

export default async function WithdrawPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, tier, status, profit_split_pct')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    notFound();
  }

  if (account.status !== 'active') {
    redirect(`/dashboard/managed-accounts/${account.id}`);
  }

  return <WithdrawForm accountId={account.id} tier={account.tier} profitSplitPct={account.profit_split_pct} />;
}
