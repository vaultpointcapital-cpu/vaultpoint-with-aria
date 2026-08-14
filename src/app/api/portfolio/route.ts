import Decimal from 'decimal.js';
import { createClient } from '@/lib/supabase/server';
import { calculatePositionPnl, calculatePositionPnlPct } from '@/lib/utils/financial';
import { Money } from '@/lib/money';
import { calculateNetWorthResult } from '@/lib/valuation/networth';
import { fxService, FxRateUnavailableError } from '@/lib/fx';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/portfolio
 * Aggregates live positions across all connected brokers plus manually
 * entered assets into the shape the dashboard needs. Per-position P&L
 * math runs through src/lib/utils/financial.ts directly (a separate
 * concern from valuation — Holding is current value, not P&L
 * attribution); net worth and total P&L run through the Valuation
 * Contract's calculateNetWorthResult() (src/lib/valuation/networth.ts) —
 * the single aggregator every net-worth-relevant source (positions,
 * manual assets, pods, prop accounts) feeds into.
 *
 * Money & Currency Layer: every money field in this response is
 * MoneyJSON ({amount, currency}), never a raw number (D4). Per-position
 * unrealized_pnl stays in that position's own currency (native display —
 * a BTCUSDT position's P&L reads naturally in USD/USDT); netWorth is
 * converted to the user's display_currency. A holding whose currency has
 * no FX rate available is excluded from the total and named in
 * `unpricedHoldings` — never silently dropped or zero-valued.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const [positionsResult, manualAssetsResult, brokerConnectionsResult, profileResult] = await Promise.all([
    // Valuation Contract: reality is trigger-maintained on the row itself
    // now — the broker_connections join here is only for display fields
    // (broker/label), not for filtering.
    supabase
      .from('positions')
      .select('*, broker_connections(broker, label, account_type)')
      .eq('user_id', authData.user.id),
    supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
    supabase
      .from('broker_connections')
      .select('id, broker, label, sync_status, last_synced_at')
      .eq('user_id', authData.user.id),
    supabase.from('users').select('display_currency').eq('id', authData.user.id).single(),
  ]);

  if (positionsResult.error || manualAssetsResult.error) {
    return apiError('INTERNAL_ERROR', 'Could not load portfolio data.');
  }

  const positions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];
  const displayCurrency = profileResult.data?.display_currency ?? 'USD';

  const positionsWithPnl = positions
    .filter((p) => p.mark_price !== null)
    .map((p) => {
      const entryPrice = Money.of(String(p.entry_price), p.currency);
      const markPrice = Money.of(String(p.mark_price), p.currency);
      const size = new Decimal(String(p.size));
      return {
        ...p,
        unrealized_pnl: calculatePositionPnl({ side: p.side, size, entryPrice, markPrice }).toJSON(),
        unrealized_pnl_pct: calculatePositionPnlPct({ side: p.side, size, entryPrice, markPrice }),
      };
    });

  const netWorthResult = await calculateNetWorthResult(authData.user.id, displayCurrency);

  // totalUnrealizedPnl is the sum of real (reality='real') positions'
  // P&L, in displayCurrency — a separate figure from net worth (net
  // worth is current value; this is change-from-entry). Converted via
  // convertAt() against netWorthResult.ratesUsed — the same rate map the
  // aggregator already fetched for these exact positions' currencies, so
  // this never triggers a second round of FX lookups.
  const realPositionsWithMoney = positions
    .filter((p) => p.reality === 'real' && p.mark_price !== null)
    .map((p) => ({
      side: p.side,
      size: new Decimal(String(p.size)),
      entryPrice: Money.of(String(p.entry_price), p.currency),
      markPrice: Money.of(String(p.mark_price), p.currency),
    }));

  let totalUnrealizedPnl = Money.zero(displayCurrency);
  for (const p of realPositionsWithMoney) {
    const pnl = calculatePositionPnl(p);
    try {
      totalUnrealizedPnl = totalUnrealizedPnl.plus(fxService.convertAt(pnl, displayCurrency, netWorthResult.ratesUsed));
    } catch (err) {
      if (!(err instanceof FxRateUnavailableError)) throw err;
      // Already reported once via netWorthResult.unpriced for this same
      // holding's currency — not double-counted here.
    }
  }

  return apiSuccess({
    netWorth: netWorthResult.total.toJSON(),
    totalUnrealizedPnl: totalUnrealizedPnl.toJSON(),
    unpricedHoldings: netWorthResult.unpriced.map((h) => h.label),
    positions: positionsWithPnl,
    manualAssets,
    brokerConnections,
    openPositionCount: positions.length,
  });
}
