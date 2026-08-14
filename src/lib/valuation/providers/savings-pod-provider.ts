import { createClient } from '@/lib/supabase/server';
import { Money } from '@/lib/money';
import type { Holding, HoldingProvider } from '@/lib/valuation/types';

/**
 * Valuation Contract — one Holding per non-archived Savings Pod, valued
 * at its running `current_amount` (already kept exact by
 * contribute_to_pod()'s atomic RPC — see
 * supabase/migrations/20260617000001_atomic_pod_contribution.sql). No
 * cost basis: "cost basis" isn't a meaningful concept for a savings
 * container, only for an asset that was bought at a price.
 */
export const savingsPodProvider: HoldingProvider = {
  sourceType: 'savings_pod',

  async list(userId: string): Promise<readonly Holding[]> {
    const supabase = createClient();
    const { data } = await supabase
      .from('savings_pods')
      .select('id, name, current_amount, currency, liquidity, updated_at')
      .eq('user_id', userId)
      .neq('status', 'archived');

    return (data ?? []).map((pod): Holding => ({
      id: `savings_pod:${pod.id}`,
      userId,
      sourceType: 'savings_pod',
      sourceId: pod.id,
      label: pod.name,
      assetClass: 'savings_pod',
      value: Money.of(String(pod.current_amount), pod.currency),
      costBasis: null,
      reality: 'real',
      liquidity: pod.liquidity,
      provenance: 'computed',
      asOf: new Date(pod.updated_at),
      // A pod's balance is exact the instant contribute_to_pod() commits
      // — there's no polling/sync lag to go stale the way a broker
      // connection has.
      stale: false,
    }));
  },
};
