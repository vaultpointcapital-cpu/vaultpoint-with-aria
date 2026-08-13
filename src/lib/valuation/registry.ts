import { positionProvider } from '@/lib/valuation/providers/position-provider';
import { manualAssetProvider } from '@/lib/valuation/providers/manual-asset-provider';
import { savingsPodProvider } from '@/lib/valuation/providers/savings-pod-provider';
import { propAccountProvider } from '@/lib/valuation/providers/prop-account-provider';
import type { HoldingProvider } from '@/lib/valuation/types';

/**
 * Valuation Contract — every source of a user's net worth. Adding a new
 * asset type (Nigerian treasury bills, a second prop firm, pensions) is a
 * new HoldingProvider file plus one line here — never an edit to
 * src/lib/valuation/networth.ts, which only ever iterates this array.
 */
export const HOLDING_PROVIDERS: readonly HoldingProvider[] = [
  positionProvider,
  manualAssetProvider,
  savingsPodProvider,
  propAccountProvider,
];
