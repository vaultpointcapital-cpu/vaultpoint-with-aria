import { createClient } from '@/lib/supabase/server';
import {
  calculateTotalPnl,
  calculateNetWorth,
  calculatePositionPnl,
  calculatePositionPnlPct,
} from '@/lib/utils/financial';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/portfolio
 * Aggregates live positions across all connected brokers plus manually
 * entered assets into the shape the dashboard needs. All P&L math runs
 * through src/lib/utils/financial.ts — the single source of truth that
 * also has unit test coverage — never recomputed inline here.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const [positionsResult, manualAssetsResult, brokerConnectionsResult] = await Promise.all([
    supabase
      .from('positions')
      .select('*, broker_connections(broker, label)')
      .eq('user_id', authData.user.id),
    supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
    supabase
      .from('broker_connections')
      .select('id, broker, label, sync_status, last_synced_at')
      .eq('user_id', authData.user.id),
  ]);

  if (positionsResult.error || manualAssetsResult.error) {
    return apiError('INTERNAL_ERROR', 'Could not load portfolio data.');
  }

  const positions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];

  const positionsWithPnl = positions
    .filter((p) => p.mark_price !== null)
    .map((p) => ({
      ...p,
      unrealized_pnl: calculatePositionPnl({
        side: p.side,
        size: p.size,
        entry_price: p.entry_price,
        mark_price: p.mark_price as number,
      }),
      unrealized_pnl_pct: calculatePositionPnlPct({
        side: p.side,
        size: p.size,
        entry_price: p.entry_price,
        mark_price: p.mark_price as number,
      }),
    }));

  const totalPnl = calculateTotalPnl(positions);
  const netWorth = calculateNetWorth(positions, manualAssets);

  return apiSuccess({
    netWorth,
    totalUnrealizedPnl: totalPnl,
    positions: positionsWithPnl,
    manualAssets,
    brokerConnections,
    openPositionCount: positions.length,
  });
}
