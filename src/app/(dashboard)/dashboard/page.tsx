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

  const [positionsResult, manualAssetsResult, podsResult, brokerConnectionsResult, snapshotsResult] =
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
      // Written once daily by the (not-yet-deployed) Python service's
      // snapshot job — may be empty for a brand new user, which is a
      // "no history yet" state, not an error.
      supabase
        .from('portfolio_snapshots')
        .select('*')
        .eq('user_id', authData.user.id)
        .order('snapshot_date', { ascending: true }),
    ]);

  const positions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const pods = podsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];
  const snapshots = snapshotsResult.data ?? [];

  const netWorth = calculateNetWorth(positions, manualAssets);
  const totalUnrealizedPnl = calculateTotalPnl(positions);

  return (
    <DashboardClient
      initialNetWorth={netWorth}
      initialPnl={totalUnrealizedPnl}
      initialPositions={positions}
      initialPods={pods}
      initialSnapshots={snapshots}
      hasConnectedBroker={brokerConnections.length > 0}
    />
  );
}
