import { createClient } from '@/lib/supabase/server';
import { Money } from '@/lib/money';
import type { Holding, HoldingProvider } from '@/lib/valuation/types';

/**
 * Valuation Contract — one Holding per manual_assets row. Unlike
 * positions, reality/liquidity/asset_class are stored directly on the row
 * (self-reported at entry time, not trigger-derived — there's no
 * connected-account source of truth to derive them from). No `asOf`
 * concept beyond `updated_at`: a manual asset is only ever as fresh as
 * the last time the user themselves touched it, which is exactly what
 * `stale` should reflect for a user-entered value.
 */
export const manualAssetProvider: HoldingProvider = {
  sourceType: 'manual_asset',

  async list(userId: string): Promise<readonly Holding[]> {
    const supabase = createClient();
    const { data } = await supabase
      .from('manual_assets')
      .select('id, label, value, currency, reality, liquidity, asset_class, updated_at')
      .eq('user_id', userId);

    const now = Date.now();
    // User-entered values are inherently self-reported — "stale" here
    // means "hasn't been reconfirmed in a while," a much longer window
    // than a live broker sync's staleness threshold.
    const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    return (data ?? []).map((a): Holding => {
      const asOf = new Date(a.updated_at);
      return {
        id: `manual_asset:${a.id}`,
        userId,
        sourceType: 'manual_asset',
        sourceId: a.id,
        label: a.label,
        assetClass: a.asset_class,
        value: Money.of(String(a.value), a.currency),
        costBasis: null,
        reality: a.reality,
        liquidity: a.liquidity,
        provenance: 'user_entered',
        asOf,
        stale: now - asOf.getTime() > STALE_AFTER_MS,
      };
    });
  },
};
