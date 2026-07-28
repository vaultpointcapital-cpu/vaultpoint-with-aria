'use client';

import { useEffect, useState } from 'react';
import { MarketChip } from '@/components/markets/market-chip';
import { formatCurrency } from '@/lib/utils/cn';

const POLL_INTERVAL_MS = 30_000;
// ~30 minutes of session history at a 30s poll cadence.
const MAX_HISTORY_POINTS = 60;

interface TickerPosition {
  id: string;
  symbol: string;
  mark_price: number | null;
  unrealized_pnl_pct: number | null;
}

interface TickerStripProps {
  initialNetWorth: number;
  initialPositions: TickerPosition[];
}

/**
 * Live-updating strip of the user's own open positions — there is no
 * general "market data" source in this codebase (no external price feed,
 * no symbol history table), only per-user broker-synced positions
 * (public.positions, refreshed ~60s by the broker-sync poll cycle). A
 * curated/trending-symbols ticker would need a new backend price feed —
 * flagged separately, not built here. Sparkline history is accumulated
 * client-side each poll (session-local, resets on reload): there's no
 * price-history table to read from, and this is the only way to satisfy
 * "re-renders on real price updates" without adding backend storage.
 */
export function TickerStrip({ initialNetWorth, initialPositions }: TickerStripProps) {
  const [netWorth, setNetWorth] = useState(initialNetWorth);
  const [positions, setPositions] = useState(initialPositions);
  const [history, setHistory] = useState<Record<string, number[]>>(() => {
    const seed: Record<string, number[]> = {};
    for (const p of initialPositions) {
      if (p.mark_price !== null) seed[p.symbol] = [p.mark_price];
    }
    return seed;
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/portfolio');
        if (!res.ok) return; // transient failure — keep showing last known data
        const data = await res.json();

        setNetWorth(data.netWorth);
        setPositions(data.positions);
        setHistory((prev) => {
          const next = { ...prev };
          for (const p of data.positions as TickerPosition[]) {
            if (p.mark_price === null) continue;
            const existing = next[p.symbol] ?? [];
            next[p.symbol] = [...existing, p.mark_price].slice(-MAX_HISTORY_POINTS);
          }
          return next;
        });
      } catch {
        // Network blip — next interval retries; never throw into the UI.
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const tracked = positions.filter((p) => p.mark_price !== null);
  if (tracked.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Portfolio value
        </span>
        {/* The single Vault Glow on this page, per design-token rule:
            exactly one, on the most important number here. */}
        <p className="vault-glow font-display text-3xl font-semibold text-text-primary">
          {formatCurrency(netWorth)}
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        {tracked.map((p) => (
          <MarketChip
            key={p.id}
            symbol={p.symbol}
            price={p.mark_price as number}
            changePct={p.unrealized_pnl_pct}
            history={history[p.symbol] ?? [p.mark_price as number]}
          />
        ))}
      </div>
    </div>
  );
}
