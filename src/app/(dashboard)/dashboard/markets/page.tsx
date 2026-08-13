import Decimal from 'decimal.js';
import { Lock } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { canUseAria } from '@/lib/validations/aria';
import { getDefaultMarketSymbol } from '@/lib/utils/tradingview';
import { calculatePositionPnlPct } from '@/lib/utils/financial';
import { Money } from '@/lib/money';
import { calculateNetWorthResult } from '@/lib/valuation/networth';
import { TradingViewChart } from '@/components/markets/tradingview-chart';
import { AriaChat } from '@/components/markets/aria-chat';
import { TickerStrip } from '@/components/markets/ticker-strip';
import { MarketsPageViewTracker } from '@/components/markets/markets-page-view-tracker';
import { Card } from '@/components/ui/card';

interface PositionSymbolRow {
  symbol: string;
  size: number;
  mark_price: number | null;
  broker_connections: { broker: string } | null;
}

export default async function MarketsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [positionsResult, profileResult] = await Promise.all([
    supabase
      .from('positions')
      .select('id, symbol, side, size, entry_price, mark_price, currency, broker_connections(broker, account_type)')
      .eq('user_id', authData.user.id),
    supabase.from('users').select('subscription_tier, display_currency').eq('id', authData.user.id).single(),
  ]);

  const positions = (positionsResult.data ?? []) as unknown as PositionSymbolRow[];
  const tier = profileResult.data?.subscription_tier ?? 'free';
  const defaultSymbol = getDefaultMarketSymbol(positions);
  const displayCurrency = profileResult.data?.display_currency ?? 'USD';

  const fullPositions = positionsResult.data ?? [];

  // Valuation Contract — the same aggregator the dashboard and Aria use.
  // Previously (pre-Valuation-Contract) this page independently
  // duplicated the fetch/filter/convert/sum block and, at one point,
  // shipped without excluding simulated positions at all — exactly the
  // drift risk a single shared aggregator exists to remove.
  const netWorthResult = await calculateNetWorthResult(authData.user.id, displayCurrency);

  // Per-position figures stay in native currency (ticker display), same
  // convention as /api/portfolio and Aria's context.
  const tickerPositions = fullPositions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    mark_price: p.mark_price,
    unrealized_pnl_pct:
      p.mark_price !== null
        ? calculatePositionPnlPct({
            side: p.side,
            size: new Decimal(String(p.size)),
            entryPrice: Money.of(String(p.entry_price), p.currency),
            markPrice: Money.of(String(p.mark_price), p.currency),
          })
        : null,
  }));

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <MarketsPageViewTracker hasPositions={tickerPositions.some((p) => p.mark_price !== null)} />
      <h1 className="font-display text-xl font-semibold text-text-primary">Markets</h1>

      <TickerStrip initialNetWorth={netWorthResult.total.toJSON()} initialPositions={tickerPositions} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TradingViewChart symbol={defaultSymbol} />
        </div>

        <div className="lg:col-span-1">
          {canUseAria(tier) ? <AriaChat symbol={defaultSymbol} /> : <AriaLockedState />}
        </div>
      </div>
    </div>
  );
}

function AriaLockedState() {
  return (
    <Card className="flex h-[600px] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10">
        <Lock className="h-6 w-6 text-accent" />
      </div>
      <div>
        <h3 className="font-display text-lg font-semibold text-text-primary">
          Aria is a Pro/Elite feature
        </h3>
        <p className="mx-auto mt-2 max-w-xs text-sm text-text-secondary">
          Chat with your AI portfolio advisor for live position insights and market context.
          Upgrade to Pro or Elite to unlock Aria.
        </p>
      </div>
    </Card>
  );
}
