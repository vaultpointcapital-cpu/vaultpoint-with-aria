import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { PayoutSettingsForm } from '@/components/payouts/payout-settings-form';

export default async function PayoutSettingsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();
  const [settingsResult, agreementsResult] = await Promise.all([
    admin.from('payout_settings').select('*').eq('id', 1).single(),
    admin.from('prop_payout_agreements').select('*').order('created_at', { ascending: false }),
  ]);

  if (!settingsResult.data) {
    return null;
  }

  return <PayoutSettingsForm settings={settingsResult.data} agreements={agreementsResult.data ?? []} />;
}
