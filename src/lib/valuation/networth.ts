import { Money } from '@/lib/money';
import { fxService, FxRateUnavailableError } from '@/lib/fx';
import { HOLDING_PROVIDERS } from '@/lib/valuation/registry';
import { countsTowardNetWorth, type Holding, type AssetClass, type Liquidity } from '@/lib/valuation/types';

export interface ValuedHolding extends Holding {
  /** null only for an excluded holding whose currency also had no
   * obtainable rate — included holdings that fail conversion are moved
   * to NetWorthResult.unpriced instead, never left with a null value here. */
  readonly valueInDisplayCurrency: Money | null;
}

export interface NetWorthResult {
  readonly total: Money; // in display currency
  readonly included: readonly ValuedHolding[];
  readonly excluded: readonly ValuedHolding[]; // simulated + pending, shown not summed
  readonly unpriced: readonly Holding[]; // no FX rate available
  readonly byAssetClass: ReadonlyMap<AssetClass, Money>;
  readonly byLiquidity: ReadonlyMap<Liquidity, Money>;
  readonly stale: boolean; // any input stale
  readonly ratesUsed: Record<string, string>; // persisted onto the snapshot
  readonly asOf: Date; // oldest included asOf
}

/**
 * Valuation Contract — the one function net worth is computed by. Runs
 * every registered HoldingProvider (src/lib/valuation/registry.ts) in
 * parallel, classifies by countsTowardNetWorth(), converts to
 * displayCurrency, and sums. Replaces the ~25-line fetch/filter/convert/
 * sum block that used to be duplicated across dashboard/page.tsx,
 * api/portfolio/route.ts, api/aria/chat/route.ts, and markets/page.tsx.
 */
export async function calculateNetWorthResult(userId: string, displayCurrency: string): Promise<NetWorthResult> {
  const holdingsByProvider = await Promise.all(HOLDING_PROVIDERS.map((provider) => provider.list(userId)));
  const allHoldings = holdingsByProvider.flat();

  const includedRaw = allHoldings.filter(countsTowardNetWorth);
  const excludedRaw = allHoldings.filter((h) => !countsTowardNetWorth(h));

  // Fetch every distinct currency actually needed ONCE — not a per-holding
  // convert() call — then use convertAt() (deterministic, no further I/O)
  // for every conversion below. This is the same D7 pattern the Money
  // Layer's portfolio_snapshots.fx_rates uses, and the rates map built
  // here becomes NetWorthResult.ratesUsed directly.
  const distinctCurrencies = Array.from(new Set([...allHoldings.map((h) => h.value.currency), displayCurrency]));
  const rateMap = await fxService.getRates(distinctCurrencies);
  const rates: Record<string, string> = {};
  let anyRateStale = false;
  for (const [currency, rate] of rateMap) {
    rates[currency] = rate.rateToUsd.toString();
    if (rate.stale) anyRateStale = true;
  }

  const unpriced: Holding[] = [];
  const included: ValuedHolding[] = [];
  for (const h of includedRaw) {
    try {
      included.push({ ...h, valueInDisplayCurrency: fxService.convertAt(h.value, displayCurrency, rates) });
    } catch (err) {
      if (err instanceof FxRateUnavailableError) {
        // Never zero, never silently dropped — named here so the UI can
        // say "we couldn't value 1 holding" instead of showing a
        // quietly-wrong total (spec §4, point 4).
        unpriced.push(h);
      } else {
        throw err;
      }
    }
  }

  // Excluded holdings are still valued for display where possible — a
  // failed conversion here doesn't move them to `unpriced` (that list is
  // specifically about holdings that would have participated in the
  // total), it just means the UI falls back to the holding's own native
  // currency for that one row.
  const excluded: ValuedHolding[] = excludedRaw.map((h) => {
    try {
      return { ...h, valueInDisplayCurrency: fxService.convertAt(h.value, displayCurrency, rates) };
    } catch (err) {
      if (err instanceof FxRateUnavailableError) return { ...h, valueInDisplayCurrency: null };
      throw err;
    }
  });

  const total = included.reduce(
    (sum, h) => (h.valueInDisplayCurrency ? sum.plus(h.valueInDisplayCurrency) : sum),
    Money.zero(displayCurrency)
  );

  const byAssetClass = new Map<AssetClass, Money>();
  const byLiquidity = new Map<Liquidity, Money>();
  for (const h of included) {
    if (!h.valueInDisplayCurrency) continue;
    byAssetClass.set(h.assetClass, (byAssetClass.get(h.assetClass) ?? Money.zero(displayCurrency)).plus(h.valueInDisplayCurrency));
    byLiquidity.set(h.liquidity, (byLiquidity.get(h.liquidity) ?? Money.zero(displayCurrency)).plus(h.valueInDisplayCurrency));
  }

  const stale = anyRateStale || included.some((h) => h.stale);

  // The weakest input, not the strongest (spec's explicit instruction) —
  // reporting freshness from the best-synced holding would flatter the
  // number users actually make decisions on.
  const asOf =
    included.length > 0 ? new Date(Math.min(...included.map((h) => h.asOf.getTime()))) : new Date();

  return { total, included, excluded, unpriced, byAssetClass, byLiquidity, stale, ratesUsed: rates, asOf };
}
