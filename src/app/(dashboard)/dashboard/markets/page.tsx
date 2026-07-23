import { Lock } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { canUseAria } from '@/lib/validations/aria';
import { getDefaultMarketSymbol } from '@/lib/utils/tradingview';
import { calculateNetWorth, calculatePositionPnlPct } from '@/lib/utils/financial';
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

  const [positionsResult, profileResult, manualAssetsResult] = await Promise.all([
    supabase
      .from('positions')
      .select('id, symbol, side, size, entry_price, mark_price, broker_connections(broker)')
      .eq('user_id', authData.user.id),
    supabase.from('users').select('subscription_tier').eq('id', authData.user.id).single(),
    supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
  ]);

  const positions = (positionsResult.data ?? []) as unknown as PositionSymbolRow[];
  const tier = profileResult.data?.subscription_tier ?? 'free';
  const defaultSymbol = getDefaultMarketSymbol(positions);

  const fullPositions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const netWorth = calculateNetWorth(fullPositions, manualAssets);
  const tickerPositions = fullPositions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    mark_price: p.mark_price,
    unrealized_pnl_pct:
      p.mark_price !== null
        ? calculatePositionPnlPct({
            side: p.side,
            size: p.size,
            entry_price: p.entry_price,
            mark_price: p.mark_price,
          })
        : null,
  }));

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <MarketsPageViewTracker hasPositions={tickerPositions.some((p) => p.mark_price !== null)} />
      <h1 className="font-display text-xl font-semibold text-text-primary">Markets</h1>

      <TickerStrip initialNetWorth={netWorth} initialPositions={tickerPositions} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TradingViewChart symbol={defaultSymbol} />
        </div>

        <div className="lg:col-span-1">{canUseAria(tier) ? <AriaChat /> : <AriaLockedState />}</div>
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
