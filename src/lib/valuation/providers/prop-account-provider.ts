import Decimal from 'decimal.js';
import { createClient } from '@/lib/supabase/server';
import { calculatePositionValue } from '@/lib/utils/financial';
import { Money } from '@/lib/money';
import type { Holding, HoldingProvider } from '@/lib/valuation/types';

/**
 * Valuation Contract — one Holding per simulated broker connection (e.g. a
 * Hantec Trader Instant Funding account — Partner Offers v1), NOT one per
 * position. This is deliberately a different provider from
 * PositionProvider even though both ultimately read the `positions`
 * table, because a prop account's headline number is meant to be account
 * equity against the challenge rules, not a sum of open positions.
 *
 * SCOPED DOWN vs. that ideal: no broker reports challenge-rule equity
 * anywhere in this app today — every BrokerClient.get_balance() exists
 * but is never called from the sync path or persisted (confirmed via
 * repo-wide grep before writing this). Building real balance-sync
 * plumbing (new poll-cycle call, new column) is a separate, speculative
 * scope increase. This provider values a prop account as the sum of its
 * own open positions' current value instead — the same math
 * PositionProvider uses, just aggregated per connection. This doesn't
 * weaken the part that actually matters: exclusion from net worth
 * (reality: 'simulated', countsTowardNetWorth() below) is exact either
 * way. Only the precision of an already-excluded figure is approximate.
 * Real equity sync is a flagged follow-up, not attempted here.
 */
export const propAccountProvider: HoldingProvider = {
  sourceType: 'prop_account',

  async list(userId: string): Promise<readonly Holding[]> {
    const supabase = createClient();

    const [connectionsResult, positionsResult] = await Promise.all([
      supabase
        .from('broker_connections')
        .select('id, label, last_synced_at')
        .eq('user_id', userId)
        .eq('account_type', 'simulated'),
      supabase
        .from('positions')
        .select('broker_connection_id, size, entry_price, mark_price, currency')
        .eq('user_id', userId)
        .eq('reality', 'simulated'),
    ]);

    const connections = connectionsResult.data ?? [];
    const positions = positionsResult.data ?? [];
    const now = Date.now();
    const STALE_AFTER_MS = 5 * 60 * 1000;

    return connections.map((connection): Holding => {
      const ownPositions = positions.filter((p) => p.broker_connection_id === connection.id);

      let value: Money;
      try {
        value = ownPositions.reduce((sum, p) => {
          const entryPrice = Money.of(String(p.entry_price), p.currency);
          const markPrice = p.mark_price === null ? null : Money.of(String(p.mark_price), p.currency);
          const positionValue = calculatePositionValue({ size: new Decimal(String(p.size)), markPrice, entryPrice });
          return sum ? sum.plus(positionValue) : positionValue;
        }, null as Money | null) ?? Money.zero('USD');
      } catch (err) {
        // A single prop account holding positions in more than one
        // currency would throw here (Money.plus's currency-mismatch
        // guard) — fail loud for that one connection, not for the whole
        // user's holdings list. Realistically shouldn't happen (a
        // challenge account has one account currency), so this is a
        // safety net, not an expected path.
        console.error(`[prop-account-provider] currency mismatch summing positions for connection ${connection.id}:`, err);
        value = Money.zero('USD');
      }

      const asOf = connection.last_synced_at ? new Date(connection.last_synced_at) : new Date(0);

      return {
        id: `prop_account:${connection.id}`,
        userId,
        sourceType: 'prop_account',
        sourceId: connection.id,
        label: connection.label,
        assetClass: 'prop_account',
        value,
        costBasis: null,
        reality: 'simulated',
        liquidity: 'illiquid',
        provenance: 'broker_api',
        asOf,
        stale: !connection.last_synced_at || now - asOf.getTime() > STALE_AFTER_MS,
      };
    });
  },
};
