import { createClient } from '@/lib/supabase/server';
import { calculateNetWorth, calculateTotalPnl } from '@/lib/utils/financial';
import { DashboardClient } from '@/components/dashboard/dashboard-client';

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [positionsResult, manualAssetsResult, podsResult, brokerConnectionsResult] =
    await Promise.all([
      supabase.from('positions').select('*').eq('user_id', authData.user.id),
      supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
      supabase
        .from('savings_pods')
        .select('*')
        .eq('user_id', authData.user.id)
        .neq('status', 'archived'),
      supabase
        .from('broker_connections')
        .select('id, broker, label, sync_status')
        .eq('user_id', authData.user.id),
    ]);

  const positions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const pods = podsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];

  const netWorth = calculateNetWorth(positions, manualAssets);
  const totalUnrealizedPnl = calculateTotalPnl(positions);

  return (
    <DashboardClient
      initialNetWorth={netWorth}
      initialPnl={totalUnrealizedPnl}
      initialPositions={positions}
      initialPods={pods}
      hasConnectedBroker={brokerConnections.length > 0}
    />
  );
}
