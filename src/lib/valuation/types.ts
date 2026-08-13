import type { Money } from '@/lib/money';
import type { Reality, Liquidity, ValuationAssetClass } from '@/types/database';

export type { Reality, Liquidity };
export type AssetClass = ValuationAssetClass;

/** Where the number came from. Drives trust badges in the UI. */
export type Provenance =
  | 'broker_api' // pulled from a connected account
  | 'user_entered' // typed by the user, unverified
  | 'computed'; // derived by us, e.g. pod balance from contributions

/**
 * Valuation Contract — one shape every net-worth-relevant asset source
 * implements. The aggregator (src/lib/valuation/networth.ts) depends only
 * on this interface, never on a specific table — adding a new asset type
 * (treasury bills, pensions) means writing a new HoldingProvider, not
 * editing the aggregator.
 */
export interface Holding {
  readonly id: string;
  readonly userId: string;
  readonly sourceType: string; // 'position' | 'manual_asset' | 'savings_pod' | 'prop_account'
  readonly sourceId: string;
  readonly label: string; // display name, e.g. "BTC/USDT" or "Lagos flat"
  readonly assetClass: AssetClass;

  readonly value: Money; // current value, native currency
  readonly costBasis: Money | null; // null where unknown or not meaningful

  readonly reality: Reality;
  readonly liquidity: Liquidity;
  readonly provenance: Provenance;

  readonly asOf: Date; // when this value was last true
  readonly stale: boolean;
}

export interface HoldingProvider {
  readonly sourceType: string;
  list(userId: string): Promise<readonly Holding[]>;
}

/**
 * The inclusion rule — the only place this logic exists. Deliberately
 * small: if it grows past a few lines, the growth belongs on the data as
 * a new `reality`/`assetClass` value, not as another condition here.
 */
export function countsTowardNetWorth(h: Holding): boolean {
  // Simulated capital is not the user's money. Non-negotiable.
  if (h.reality === 'simulated') return false;
  // Pending payouts are real but unsettled — shown separately, not in the total.
  if (h.reality === 'pending') return false;
  return true;
}
