import { PriceTag } from '@/components/markets/price-tag';
import { Sparkline } from '@/components/markets/sparkline';

interface MarketChipProps {
  symbol: string;
  price: number;
  changePct: number | null;
  history: number[];
}

/**
 * One ticker entry: symbol, live price + delta, and its session sparkline.
 * `history` is this session's accumulated price points for this symbol
 * (see TickerStrip) — there is no backend price-history table, so this
 * necessarily starts flat on page load and fills in as polling continues.
 */
export function MarketChip({ symbol, price, changePct, history }: MarketChipProps) {
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="font-body text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {symbol}
        </span>
      </div>
      <PriceTag price={price} changePct={changePct} />
      <Sparkline data={history} positive={(changePct ?? 0) >= 0} />
    </div>
  );
}
