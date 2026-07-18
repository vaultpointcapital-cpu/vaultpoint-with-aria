import { createClient } from '@/lib/supabase/server';
import { BrokersClient } from '@/components/brokers/brokers-client';

export default async function BrokersPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetch below, not a real runtime path.
    return null;
  }

  const { data } = await supabase
    .from('broker_connections')
    .select(
      'id, broker, label, is_read_only, trade_execution_enabled, sync_status, last_synced_at, last_error, created_at'
    )
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  return <BrokersClient initialConnections={data ?? []} />;
}
