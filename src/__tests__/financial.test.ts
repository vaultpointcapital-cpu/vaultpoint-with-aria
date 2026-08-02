import { describe, it, expect } from 'vitest';
import {
  calculatePositionPnl,
  calculatePositionPnlPct,
  calculateTotalPnl,
  calculatePositionValue,
  calculateNetWorth,
  calculateDayChange,
  calculateAllocation,
  calculatePodProgress,
  calculateMarginUtilization,
  excludeSimulatedPositions,
} from '@/lib/utils/financial';

describe('calculatePositionPnl', () => {
  it('returns positive P&L for a profitable long', () => {
    const pnl = calculatePositionPnl({
      side: 'long',
      size: 1,
      entry_price: 100,
      mark_price: 110,
    });
    expect(pnl).toBe(10);
  });

  it('returns negative P&L for a losing long', () => {
    const pnl = calculatePositionPnl({
      side: 'long',
      size: 1,
      entry_price: 100,
      mark_price: 90,
    });
    expect(pnl).toBe(-10);
  });

  it('returns positive P&L for a profitable short', () => {
    const pnl = calculatePositionPnl({
      side: 'short',
      size: 1,
      entry_price: 100,
      mark_price: 90,
    });
    expect(pnl).toBe(10);
  });

  it('returns negative P&L for a losing short', () => {
    const pnl = calculatePositionPnl({
      side: 'short',
      size: 1,
      entry_price: 100,
      mark_price: 110,
    });
    expect(pnl).toBe(-10);
  });

  it('scales correctly with position size', () => {
    const pnl = calculatePositionPnl({
      side: 'long',
      size: 0.42,
      entry_price: 67000,
      mark_price: 68000,
    });
    expect(pnl).toBeCloseTo(420, 5);
  });

  it('treats "buy" the same as "long"', () => {
    const buyPnl = calculatePositionPnl({
      side: 'buy',
      size: 1,
      entry_price: 100,
      mark_price: 110,
    });
    expect(buyPnl).toBe(10);
  });

  it('treats "sell" the same as "short"', () => {
    const sellPnl = calculatePositionPnl({
      side: 'sell',
      size: 1,
      entry_price: 100,
      mark_price: 90,
    });
    expect(sellPnl).toBe(10);
  });
});

describe('calculatePositionPnlPct', () => {
  it('calculates percentage return correctly for a long', () => {
    const pct = calculatePositionPnlPct({
      side: 'long',
      size: 1,
      entry_price: 100,
      mark_price: 110,
    });
    expect(pct).toBe(10);
  });

  it('returns 0 instead of NaN when entry value is 0', () => {
    const pct = calculatePositionPnlPct({
      side: 'long',
      size: 0,
      entry_price: 0,
      mark_price: 110,
    });
    expect(pct).toBe(0);
    expect(Number.isNaN(pct)).toBe(false);
  });
});

describe('calculateTotalPnl', () => {
  it('sums P&L across multiple positions', () => {
    const total = calculateTotalPnl([
      { side: 'long', size: 1, entry_price: 100, mark_price: 110 },
      { side: 'short', size: 2, entry_price: 50, mark_price: 45 },
    ]);
    // Position 1: +10, Position 2: +10 (2 * (50-45))
    expect(total).toBe(20);
  });

  it('skips positions with no mark_price instead of throwing', () => {
    const total = calculateTotalPnl([
      { side: 'long', size: 1, entry_price: 100, mark_price: null },
      { side: 'long', size: 1, entry_price: 100, mark_price: 110 },
    ]);
    expect(total).toBe(10);
  });

  it('returns 0 for an empty position list', () => {
    expect(calculateTotalPnl([])).toBe(0);
  });
});

describe('calculatePositionValue', () => {
  it('uses mark_price when available', () => {
    const value = calculatePositionValue({ size: 2, mark_price: 100, entry_price: 90 });
    expect(value).toBe(200);
  });

  it('falls back to entry_price when mark_price is null', () => {
    const value = calculatePositionValue({ size: 2, mark_price: null, entry_price: 90 });
    expect(value).toBe(180);
  });

  it('uses absolute size for short positions (negative size convention)', () => {
    const value = calculatePositionValue({ size: -2, mark_price: 100, entry_price: 90 });
    expect(value).toBe(200);
  });
});

describe('calculateNetWorth', () => {
  it('sums position value and manual asset value', () => {
    const netWorth = calculateNetWorth(
      [{ size: 1, mark_price: 1000, entry_price: 900 }],
      [{ value: 5000 }]
    );
    expect(netWorth).toBe(6000);
  });

  it('returns 0 when there are no positions or assets', () => {
    expect(calculateNetWorth([], [])).toBe(0);
  });

  it('handles multiple positions and assets together', () => {
    const netWorth = calculateNetWorth(
      [
        { size: 1, mark_price: 100, entry_price: 90 },
        { size: 2, mark_price: 50, entry_price: 45 },
      ],
      [{ value: 1000 }, { value: 2000 }]
    );
    // 100 + 100 + 1000 + 2000
    expect(netWorth).toBe(3200);
  });

  it('is unaffected by a simulated-capital position once excludeSimulatedPositions runs first — Partner Offers v1 non-negotiable rule', () => {
    const livePosition = { size: 1, mark_price: 1000, entry_price: 900, broker_connections: { account_type: 'live' } };
    const simulatedPosition = {
      size: 1,
      mark_price: 50000,
      entry_price: 40000,
      broker_connections: { account_type: 'simulated' },
    };
    const manualAssets = [{ value: 5000 }];

    const withoutSimulated = calculateNetWorth([livePosition], manualAssets);
    const filteredThenCalculated = calculateNetWorth(
      excludeSimulatedPositions([livePosition, simulatedPosition]),
      manualAssets
    );

    expect(filteredThenCalculated).toBe(withoutSimulated);
  });
});

describe('excludeSimulatedPositions', () => {
  it('drops positions whose connection is simulated', () => {
    const positions = [
      { id: '1', broker_connections: { account_type: 'live' } },
      { id: '2', broker_connections: { account_type: 'simulated' } },
      { id: '3', broker_connections: null },
    ];
    const result = excludeSimulatedPositions(positions);
    expect(result.map((p) => p.id)).toEqual(['1', '3']);
  });
});

describe('calculateDayChange', () => {
  it('calculates positive day change correctly', () => {
    const change = calculateDayChange(84320, 82478);
    expect(change.absolute).toBeCloseTo(1842, 5);
    expect(change.percentage).toBeCloseTo(2.233, 2);
  });

  it('calculates negative day change correctly', () => {
    const change = calculateDayChange(80000, 82000);
    expect(change.absolute).toBe(-2000);
    expect(change.percentage).toBeCloseTo(-2.439, 2);
  });

  it('returns 0% change instead of Infinity when yesterday was 0', () => {
    const change = calculateDayChange(100, 0);
    expect(change.percentage).toBe(0);
    expect(Number.isFinite(change.percentage)).toBe(true);
  });
});

describe('calculateAllocation', () => {
  it('calculates percentages that sum to 100', () => {
    const alloc = calculateAllocation({ crypto: 52, forex: 28, gold: 14, cash: 6 });
    const sum = alloc.crypto + alloc.forex + alloc.gold + alloc.cash;
    expect(sum).toBeCloseTo(100, 5);
    expect(alloc.crypto).toBe(52);
  });

  it('returns all zeros instead of NaN when total is 0', () => {
    const alloc = calculateAllocation({ crypto: 0, forex: 0, gold: 0, cash: 0 });
    expect(alloc).toEqual({ crypto: 0, forex: 0, gold: 0, cash: 0 });
  });
});

describe('calculatePodProgress', () => {
  it('calculates progress percentage correctly', () => {
    expect(calculatePodProgress(6840, 10000)).toBe(68.4);
  });

  it('clamps progress at 100 when current exceeds target', () => {
    expect(calculatePodProgress(15000, 10000)).toBe(100);
  });

  it('returns 0 when target is 0 instead of dividing by zero', () => {
    expect(calculatePodProgress(500, 0)).toBe(0);
  });

  it('returns 0 for a brand new pod with no contributions', () => {
    expect(calculatePodProgress(0, 5000)).toBe(0);
  });
});

describe('calculateMarginUtilization', () => {
  it('calculates margin utilization percentage', () => {
    expect(calculateMarginUtilization(28668, 84320)).toBeCloseTo(34.0, 1);
  });

  it('clamps at 100 even if margin used exceeds equity', () => {
    expect(calculateMarginUtilization(100000, 50000)).toBe(100);
  });

  it('returns 0 when total equity is 0 or negative', () => {
    expect(calculateMarginUtilization(1000, 0)).toBe(0);
    expect(calculateMarginUtilization(1000, -500)).toBe(0);
  });
});
