import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { DisputesTable } from '@/components/disputes/disputes-table';

export default async function DisputesPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();
  const { data: disputes } = await admin.from('disputes').select('*').order('opened_at', { ascending: false });

  return <DisputesTable disputes={disputes ?? []} />;
}
