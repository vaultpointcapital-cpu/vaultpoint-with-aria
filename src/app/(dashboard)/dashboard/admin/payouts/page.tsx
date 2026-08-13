import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { PayoutsAdminView } from '@/components/payouts/payouts-admin-view';

export default async function PayoutsAdminPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();
  const [eventsResult, ledgerResult] = await Promise.all([
    admin.from('withdrawal_events').select('*').order('detected_at', { ascending: false }),
    admin.from('payout_ledger').select('*').order('created_at', { ascending: false }),
  ]);

  return <PayoutsAdminView events={eventsResult.data ?? []} ledgerEntries={ledgerResult.data ?? []} />;
}
