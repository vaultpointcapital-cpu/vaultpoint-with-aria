import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ReconfirmForm } from '@/components/managed-accounts/reconfirm-form';

export default async function ReconfirmPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, requires_disclosure_reconfirmation')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    notFound();
  }

  if (!account.requires_disclosure_reconfirmation) {
    redirect(`/dashboard/managed-accounts/${account.id}`);
  }

  return <ReconfirmForm accountId={account.id} />;
}
