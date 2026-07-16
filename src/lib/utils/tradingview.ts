import type { BrokerType } from '@/types/database';

/**
 * Shown when the user has no priced positions yet, or their broker isn't
 * in the map below — a real, liquid symbol rather than a blank chart.
 */
export const DEFAULT_TRADINGVIEW_SYMBOL = 'BYBIT:BTCUSDT';

// MT5/Hantec metals trade on OANDA's feed on TradingView; other forex
// pairs use the generic FX exchange.
const METAL_SYMBOLS = new Set(['XAUUSD', 'XAGUSD']);

/**
 * Maps a VaultPoint broker + raw symbol to TradingView's `EXCHANGE:SYMBOL`
 * format. A lookup keyed on broker, not a hardcoded per-symbol switch, so
 * a new supported broker only needs one new case.
 */
export function toTradingViewSymbol(broker: string, rawSymbol: string): string {
  const symbol = rawSymbol.toUpperCase().replace(/[-_/]/g, '');

  switch (broker as BrokerType) {
    case 'bybit':
      return `BYBIT:${symbol}`;
    case 'binance':
      return `BINANCE:${symbol}`;
    case 'kucoin':
      return `KUCOIN:${symbol}`;
    case 'metatrader':
      return METAL_SYMBOLS.has(symbol) ? `OANDA:${symbol}` : `FX:${symbol}`;
    default:
      console.warn(`[tradingview] Unrecognized broker "${broker}" — using default symbol.`);
      return DEFAULT_TRADINGVIEW_SYMBOL;
  }
}

interface PositionForSymbolLookup {
  symbol: string;
  size: number;
  mark_price: number | null;
  broker_connections: { broker: string } | null;
}

/**
 * Default Markets page chart symbol: the user's largest open position by
 * notional value (size * mark price), falling back to a sensible default
 * if they have no priced positions.
 */
export function getDefaultMarketSymbol(positions: PositionForSymbolLookup[]): string {
  const priced = positions.filter(
    (p): p is PositionForSymbolLookup & { mark_price: number } => p.mark_price !== null
  );

  if (priced.length === 0) return DEFAULT_TRADINGVIEW_SYMBOL;

  const largest = priced.reduce((max, p) =>
    Math.abs(p.size * p.mark_price) > Math.abs(max.size * max.mark_price) ? p : max
  );

  return toTradingViewSymbol(largest.broker_connections?.broker ?? '', largest.symbol);
}
