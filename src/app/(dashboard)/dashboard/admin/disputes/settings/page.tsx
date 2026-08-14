import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { DisputeSettingsForm } from '@/components/disputes/dispute-settings-form';

export default async function DisputeSettingsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();
  const { data: settings } = await admin.from('dispute_settings').select('*').eq('id', 1).single();

  if (!settings) {
    return null;
  }

  return <DisputeSettingsForm settings={settings} />;
}
