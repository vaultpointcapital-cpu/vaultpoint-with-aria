import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toTradingViewSymbol,
  getDefaultMarketSymbol,
  DEFAULT_TRADINGVIEW_SYMBOL,
} from '@/lib/utils/tradingview';

describe('toTradingViewSymbol', () => {
  it('maps bybit to the BYBIT exchange prefix', () => {
    expect(toTradingViewSymbol('bybit', 'BTCUSDT')).toBe('BYBIT:BTCUSDT');
  });

  it('maps binance to the BINANCE exchange prefix', () => {
    expect(toTradingViewSymbol('binance', 'ETHUSDT')).toBe('BINANCE:ETHUSDT');
  });

  it('maps kucoin to the KUCOIN exchange prefix', () => {
    expect(toTradingViewSymbol('kucoin', 'XBTUSDTM')).toBe('KUCOIN:XBTUSDTM');
  });

  it('maps metatrader forex pairs to the FX exchange', () => {
    expect(toTradingViewSymbol('metatrader', 'EURUSD')).toBe('FX:EURUSD');
  });

  it('maps metatrader metals to the OANDA exchange', () => {
    expect(toTradingViewSymbol('metatrader', 'XAUUSD')).toBe('OANDA:XAUUSD');
    expect(toTradingViewSymbol('metatrader', 'XAGUSD')).toBe('OANDA:XAGUSD');
  });

  it('strips separators and uppercases the raw symbol', () => {
    expect(toTradingViewSymbol('bybit', 'btc-usdt')).toBe('BYBIT:BTCUSDT');
    expect(toTradingViewSymbol('binance', 'eth_usdt')).toBe('BINANCE:ETHUSDT');
    expect(toTradingViewSymbol('metatrader', 'eur/usd')).toBe('FX:EURUSD');
  });

  it('falls back to the default symbol for an unrecognized broker', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toTradingViewSymbol('coinbase', 'BTCUSD')).toBe(DEFAULT_TRADINGVIEW_SYMBOL);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe('getDefaultMarketSymbol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the default symbol when there are no positions', () => {
    expect(getDefaultMarketSymbol([])).toBe(DEFAULT_TRADINGVIEW_SYMBOL);
  });

  it('returns the default symbol when no positions have a mark price', () => {
    const positions = [
      { symbol: 'BTCUSDT', size: 1, mark_price: null, broker_connections: { broker: 'bybit' } },
    ];
    expect(getDefaultMarketSymbol(positions)).toBe(DEFAULT_TRADINGVIEW_SYMBOL);
  });

  it('picks the position with the largest notional value', () => {
    const positions = [
      { symbol: 'ETHUSDT', size: 1, mark_price: 3000, broker_connections: { broker: 'binance' } },
      { symbol: 'BTCUSDT', size: 0.5, mark_price: 60000, broker_connections: { broker: 'bybit' } },
      { symbol: 'XRPUSDT', size: 100, mark_price: 0.5, broker_connections: { broker: 'kucoin' } },
    ];
    // Notional: ETH=3000, BTC=30000, XRP=50 — BTC wins.
    expect(getDefaultMarketSymbol(positions)).toBe('BYBIT:BTCUSDT');
  });

  it('uses absolute notional value so a large short still wins', () => {
    const positions = [
      { symbol: 'BTCUSDT', size: -2, mark_price: 60000, broker_connections: { broker: 'bybit' } },
      { symbol: 'ETHUSDT', size: 1, mark_price: 3000, broker_connections: { broker: 'binance' } },
    ];
    expect(getDefaultMarketSymbol(positions)).toBe('BYBIT:BTCUSDT');
  });

  it('ignores unpriced positions when picking the largest', () => {
    const positions = [
      { symbol: 'BTCUSDT', size: 100, mark_price: null, broker_connections: { broker: 'bybit' } },
      { symbol: 'ETHUSDT', size: 1, mark_price: 3000, broker_connections: { broker: 'binance' } },
    ];
    expect(getDefaultMarketSymbol(positions)).toBe('BINANCE:ETHUSDT');
  });

  it('falls back to the default symbol when broker_connections is null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const positions = [{ symbol: 'BTCUSDT', size: 1, mark_price: 60000, broker_connections: null }];
    expect(getDefaultMarketSymbol(positions)).toBe(DEFAULT_TRADINGVIEW_SYMBOL);
    warnSpy.mockRestore();
  });
});
