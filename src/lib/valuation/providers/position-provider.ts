import Decimal from 'decimal.js';
import { createClient } from '@/lib/supabase/server';
import { calculatePositionValue } from '@/lib/utils/financial';
import { Money } from '@/lib/money';
import type { Holding, HoldingProvider } from '@/lib/valuation/types';

// Same bucketing this app's Python broker-sync service already uses
// (services/broker-sync/app/sync_service.py's CRYPTO_BROKERS) — no shared
// module between the two runtimes, so kept in sync by hand, same as
// financial.ts/financial.py already are.
const CRYPTO_BROKERS = new Set(['bybit', 'binance', 'kucoin']);

/**
 * Valuation Contract — one Holding per position where reality='real'.
 * Queries directly on positions.reality (trigger-maintained, see
 * supabase/migrations/20260805000000_add_valuation_contract.sql) rather
 * than joining broker_connections and filtering at runtime — the
 * simplification that column buys. Simulated positions are
 * PropAccountProvider's concern, not this one's.
 */
export const positionProvider: HoldingProvider = {
  sourceType: 'position',

  async list(userId: string): Promise<readonly Holding[]> {
    const supabase = createClient();
    const { data } = await supabase
      .from('positions')
      .select('id, symbol, size, entry_price, mark_price, currency, synced_at, broker_connections(broker)')
      .eq('user_id', userId)
      .eq('reality', 'real');

    const now = Date.now();
    const STALE_AFTER_MS = 5 * 60 * 1000; // matches the poll cycle's own 60s cadence, generous headroom

    return (data ?? []).map((p): Holding => {
      const entryPrice = Money.of(String(p.entry_price), p.currency);
      const markPrice = p.mark_price === null ? null : Money.of(String(p.mark_price), p.currency);
      const size = new Decimal(String(p.size));
      const broker = p.broker_connections?.broker ?? '';
      const asOf = new Date(p.synced_at);

      return {
        id: `position:${p.id}`,
        userId,
        sourceType: 'position',
        sourceId: p.id,
        label: p.symbol,
        assetClass: CRYPTO_BROKERS.has(broker) ? 'crypto' : 'fx',
        value: calculatePositionValue({ size, markPrice, entryPrice }),
        costBasis: entryPrice.times(size.abs()),
        reality: 'real',
        liquidity: 'liquid',
        provenance: 'broker_api',
        asOf,
        stale: now - asOf.getTime() > STALE_AFTER_MS,
      };
    });
  },
};
