/**
 * Financial calculation utilities — Money & Currency Layer.
 *
 * Per dev rule #4: financial calculations must have unit tests. See
 * src/__tests__/financial.test.ts for the corresponding test suite —
 * every function here is covered.
 *
 * These are pure functions with no I/O, deliberately — easy to test,
 * easy to reason about, and safe to call from both the Next.js API
 * routes and (translated) the FastAPI service without drift.
 *
 * Every amount here is Money, never a raw number (D2) — see
 * src/lib/money.ts. Aggregation functions (calculateTotalPnl,
 * calculateNetWorth, calculateAllocation) require every input already in
 * the SAME currency; Money.plus()/ratioTo() throw on a mismatch rather
 * than silently converting. Currency normalization (via FxService) is the
 * CALLER's job, done before calling into this file — conversion needs
 * live rates (I/O), which these functions deliberately never touch.
 * Percentages stay plain `number` — a ratio isn't money in D2's sense.
 */

import type Decimal from 'decimal.js';
import { Money } from '@/lib/money';

export interface PositionMoneyInput {
  side: 'long' | 'short' | 'buy' | 'sell';
  size: Decimal;
  entryPrice: Money;
  markPrice: Money;
}

/**
 * Unrealized P&L for a single position, in quote currency.
 * Long: profit when mark > entry. Short: profit when mark < entry.
 */
export function calculatePositionPnl(position: PositionMoneyInput): Money {
  const isLong = position.side === 'long' || position.side === 'buy';
  const diff = isLong ? position.markPrice.minus(position.entryPrice) : position.entryPrice.minus(position.markPrice);
  return diff.times(position.size);
}

/**
 * Unrealized P&L as a percentage of the position's entry value.
 * Returns 0 rather than throwing/NaN when entry value is 0, since a
 * zero-cost position has no meaningful percentage return.
 */
export function calculatePositionPnlPct(position: PositionMoneyInput): number {
  const entryValue = position.entryPrice.times(position.size);
  if (entryValue.isZero()) return 0;
  return calculatePositionPnl(position).ratioTo(entryValue).times(100).toNumber();
}

/**
 * Total unrealized P&L across all open positions. Every position must
 * already be in `currency` — a mixed-currency position throws via
 * Money.plus(), same "caller normalizes first" rule as calculateNetWorth.
 * Positions with no mark price yet (still syncing) are skipped, same as
 * the original number-based implementation.
 */
export function calculateTotalPnl(
  positions: Array<{ side: PositionMoneyInput['side']; size: Decimal; entryPrice: Money; markPrice: Money | null }>,
  currency: string
): Money {
  return positions.reduce((sum, p) => {
    if (p.markPrice === null) return sum;
    return sum.plus(calculatePositionPnl({ side: p.side, size: p.size, entryPrice: p.entryPrice, markPrice: p.markPrice }));
  }, Money.zero(currency));
}

/**
 * Current market value of a single position (size * mark price, falling
 * back to entry price if not yet synced). Used for net worth aggregation
 * and allocation percentage breakdowns.
 */
export function calculatePositionValue(position: { size: Decimal; markPrice: Money | null; entryPrice: Money }): Money {
  const price = position.markPrice ?? position.entryPrice;
  return price.times(position.size.abs());
}

/**
 * Aggregates total net worth across broker positions and manually entered
 * assets (bank, property, other). Kept for callers that need a same-
 * currency positions/manualAssets sum directly (e.g. per-position P&L
 * display totals) — the canonical, whole-portfolio net worth figure now
 * comes from src/lib/valuation/networth.ts's calculateNetWorthResult(),
 * which classifies every source (including simulated/prop-account
 * capital — see the Valuation Contract's `reality` column, trigger-
 * maintained, replacing the old excludeSimulatedPositions() runtime
 * filter this function used to require callers to apply by hand) and
 * sums Holdings directly rather than through this positions/manualAssets
 * shape.
 *
 * Every position/asset must already be Money in `currency` — the caller
 * is responsible for fetching each row's own currency and converting via
 * FxService BEFORE calling this. This function has no DB access and
 * cannot filter or convert for itself.
 */
export function calculateNetWorth(
  positions: Array<{ size: Decimal; markPrice: Money | null; entryPrice: Money }>,
  manualAssets: Array<{ value: Money }>,
  currency: string
): Money {
  const positionsValue = positions.reduce((sum, p) => sum.plus(calculatePositionValue(p)), Money.zero(currency));
  const manualValue = manualAssets.reduce((sum, a) => sum.plus(a.value), Money.zero(currency));
  return positionsValue.plus(manualValue);
}

/**
 * Day-over-day change, both absolute and percentage. Used for the
 * "+$1,842 today (+2.23%)" hero stat. Returns 0% change if yesterday's
 * value was 0, to avoid a divide-by-zero. Both values must already be in
 * the same currency — enforced by Money.minus().
 */
export function calculateDayChange(todayValue: Money, yesterdayValue: Money): { absolute: Money; percentage: number } {
  const absolute = todayValue.minus(yesterdayValue);
  const percentage = yesterdayValue.isZero() ? 0 : absolute.ratioTo(yesterdayValue).times(100).toNumber();
  return { absolute, percentage };
}

/**
 * Allocation breakdown by category as percentages that sum to 100
 * (or to 0 if there's nothing allocated yet). Used to drive the
 * Allocation panel's progress bars. All four categories must already
 * share a currency — enforced by Money.plus().
 */
export function calculateAllocation(categories: {
  crypto: Money;
  forex: Money;
  gold: Money;
  cash: Money;
}): { crypto: number; forex: number; gold: number; cash: number } {
  const total = categories.crypto.plus(categories.forex).plus(categories.gold).plus(categories.cash);
  if (total.isZero()) {
    return { crypto: 0, forex: 0, gold: 0, cash: 0 };
  }
  return {
    crypto: categories.crypto.ratioTo(total).times(100).toNumber(),
    forex: categories.forex.ratioTo(total).times(100).toNumber(),
    gold: categories.gold.ratioTo(total).times(100).toNumber(),
    cash: categories.cash.ratioTo(total).times(100).toNumber(),
  };
}

/**
 * Progress toward a Savings Pod's target, clamped to [0, 100]. Clamping
 * matters because a user can contribute past their original target —
 * the UI arc should show "complete," not overflow past 100%. Both
 * amounts must already be in the same currency — enforced by ratioTo().
 */
export function calculatePodProgress(currentAmount: Money, targetAmount: Money): number {
  if (targetAmount.isZero() || targetAmount.isNegative()) return 0;
  const pct = currentAmount.ratioTo(targetAmount).times(100).toNumber();
  return Math.min(100, Math.max(0, pct));
}

/**
 * Margin utilization percentage — used by the margin_pct alert condition
 * type and the "Margin Used" dashboard card. Margin used is the sum of
 * each leveraged position's required margin; total equity is net worth.
 * Both must already be in the same currency — enforced by ratioTo().
 */
export function calculateMarginUtilization(marginUsed: Money, totalEquity: Money): number {
  if (totalEquity.isZero() || totalEquity.isNegative()) return 0;
  return Math.min(100, marginUsed.ratioTo(totalEquity).times(100).toNumber());
}
