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

  const [connectionsResult, profileResult] = await Promise.all([
    supabase
      .from('broker_connections')
      .select(
        'id, broker, label, is_read_only, trade_execution_enabled, managed_mode_enabled, managed_mode_risk_pct, managed_mode_daily_loss_limit_pct, sync_status, last_synced_at, last_error, created_at'
      )
      .eq('user_id', authData.user.id)
      // See DELETE /api/brokers/:id — a connection with trade history is
      // soft-disconnected (sync_status='disconnected'), not deleted.
      .neq('sync_status', 'disconnected')
      .order('created_at', { ascending: false }),
    supabase.from('users').select('subscription_tier').eq('id', authData.user.id).single(),
  ]);

  return (
    <BrokersClient
      initialConnections={connectionsResult.data ?? []}
      subscriptionTier={profileResult.data?.subscription_tier ?? 'free'}
    />
  );
}
