/**
 * Financial calculation utilities.
 *
 * Per dev rule #4: financial calculations must have unit tests. See
 * src/__tests__/financial.test.ts for the corresponding test suite —
 * every function here is covered.
 *
 * These are pure functions with no I/O, deliberately — easy to test,
 * easy to reason about, and safe to call from both the Next.js API
 * routes and (translated) the FastAPI service without drift.
 */

import type { Position, ManualAsset } from '@/types/database';

/**
 * Unrealized P&L for a single position, in quote currency.
 * Long: profit when mark > entry. Short: profit when mark < entry.
 */
export function calculatePositionPnl(position: {
  side: 'long' | 'short' | 'buy' | 'sell';
  size: number;
  entry_price: number;
  mark_price: number;
}): number {
  const isLong = position.side === 'long' || position.side === 'buy';
  const priceDiff = position.mark_price - position.entry_price;
  return isLong ? priceDiff * position.size : -priceDiff * position.size;
}

/**
 * Unrealized P&L as a percentage of the position's entry value.
 * Returns 0 rather than NaN/Infinity when entry value is 0, since a
 * zero-cost position has no meaningful percentage return.
 */
export function calculatePositionPnlPct(position: {
  side: 'long' | 'short' | 'buy' | 'sell';
  size: number;
  entry_price: number;
  mark_price: number;
}): number {
  const entryValue = position.entry_price * position.size;
  if (entryValue === 0) return 0;
  const pnl = calculatePositionPnl(position);
  return (pnl / entryValue) * 100;
}

/**
 * Total unrealized P&L across all open positions.
 */
export function calculateTotalPnl(
  positions: Array<Pick<Position, 'side' | 'size' | 'entry_price' | 'mark_price'>>
): number {
  return positions.reduce((sum, p) => {
    if (p.mark_price === null) return sum;
    return (
      sum +
      calculatePositionPnl({
        side: p.side,
        size: p.size,
        entry_price: p.entry_price,
        mark_price: p.mark_price,
      })
    );
  }, 0);
}

/**
 * Current market value of a single position (size * mark price).
 * Used for net worth aggregation and allocation percentage breakdowns.
 */
export function calculatePositionValue(position: {
  size: number;
  mark_price: number | null;
  entry_price: number;
}): number {
  const price = position.mark_price ?? position.entry_price;
  return Math.abs(position.size) * price;
}

/**
 * Filters out positions held in a simulated-capital connection (e.g. a
 * Hantec Trader Instant Funding account — see Partner Offers v1,
 * supabase/migrations/20260803000000_add_partner_offers.sql) before they
 * ever reach calculateNetWorth/calculateTotalPnl. A simulated balance is
 * not the user's own money; every net-worth computation in this codebase
 * (dashboard SSR page, /api/portfolio, Aria's chat context, and the Python
 * daily snapshot job) must run positions through this first. Not
 * toggleable — there is no path that includes simulated positions in net
 * worth by design.
 */
export function excludeSimulatedPositions<T extends { broker_connections: { account_type?: string } | null }>(
  positions: T[]
): T[] {
  return positions.filter((p) => p.broker_connections?.account_type !== 'simulated');
}

/**
 * Aggregates total net worth across broker positions and manually entered
 * assets (bank, property, other). This is the single source of truth for
 * the "Total Portfolio Value" figure shown on the dashboard — never
 * recompute this inline in a component. Callers must pass positions
 * already filtered through excludeSimulatedPositions() if the position
 * shape includes a broker_connections join — this function has no DB
 * access and cannot filter for itself.
 */
export function calculateNetWorth(
  positions: Array<Pick<Position, 'size' | 'mark_price' | 'entry_price'>>,
  manualAssets: Array<Pick<ManualAsset, 'value'>>
): number {
  const positionsValue = positions.reduce(
    (sum, p) => sum + calculatePositionValue(p),
    0
  );
  const manualValue = manualAssets.reduce((sum, a) => sum + a.value, 0);
  return positionsValue + manualValue;
}

/**
 * Day-over-day change, both absolute and percentage. Used for the
 * "+$1,842 today (+2.23%)" hero stat. Returns 0% change if yesterday's
 * value was 0, to avoid a divide-by-zero producing Infinity in the UI.
 */
export function calculateDayChange(
  todayValue: number,
  yesterdayValue: number
): { absolute: number; percentage: number } {
  const absolute = todayValue - yesterdayValue;
  const percentage = yesterdayValue === 0 ? 0 : (absolute / yesterdayValue) * 100;
  return { absolute, percentage };
}

/**
 * Allocation breakdown by category as percentages that sum to 100
 * (or to 0 if there's nothing allocated yet). Used to drive the
 * Allocation panel's progress bars.
 */
export function calculateAllocation(categories: {
  crypto: number;
  forex: number;
  gold: number;
  cash: number;
}): { crypto: number; forex: number; gold: number; cash: number } {
  const total = categories.crypto + categories.forex + categories.gold + categories.cash;
  if (total === 0) {
    return { crypto: 0, forex: 0, gold: 0, cash: 0 };
  }
  return {
    crypto: (categories.crypto / total) * 100,
    forex: (categories.forex / total) * 100,
    gold: (categories.gold / total) * 100,
    cash: (categories.cash / total) * 100,
  };
}

/**
 * Progress toward a Savings Pod's target, clamped to [0, 100]. Clamping
 * matters because a user can contribute past their original target —
 * the UI arc should show "complete," not overflow past 100%.
 */
export function calculatePodProgress(currentAmount: number, targetAmount: number): number {
  if (targetAmount <= 0) return 0;
  const pct = (currentAmount / targetAmount) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Margin utilization percentage — used by the margin_pct alert condition
 * type and the "Margin Used" dashboard card. Margin used is the sum of
 * each leveraged position's required margin; total equity is net worth.
 */
export function calculateMarginUtilization(
  marginUsed: number,
  totalEquity: number
): number {
  if (totalEquity <= 0) return 0;
  return Math.min(100, (marginUsed / totalEquity) * 100);
}
