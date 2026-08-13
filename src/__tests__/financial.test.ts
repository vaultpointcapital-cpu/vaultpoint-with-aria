import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
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
} from '@/lib/utils/financial';
import { Money } from '@/lib/money';

function usd(amount: string): Money {
  return Money.of(amount, 'USD');
}

function d(amount: string): Decimal {
  return new Decimal(amount);
}

describe('calculatePositionPnl', () => {
  it('returns positive P&L for a profitable long', () => {
    const pnl = calculatePositionPnl({ side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') });
    expect(pnl.toJSON()).toEqual({ amount: '10.00000000', currency: 'USD' });
  });

  it('returns negative P&L for a losing long', () => {
    const pnl = calculatePositionPnl({ side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: usd('90') });
    expect(pnl.toJSON().amount).toBe('-10.00000000');
  });

  it('returns positive P&L for a profitable short', () => {
    const pnl = calculatePositionPnl({ side: 'short', size: d('1'), entryPrice: usd('100'), markPrice: usd('90') });
    expect(pnl.toJSON().amount).toBe('10.00000000');
  });

  it('returns negative P&L for a losing short', () => {
    const pnl = calculatePositionPnl({ side: 'short', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') });
    expect(pnl.toJSON().amount).toBe('-10.00000000');
  });

  it('scales correctly with position size', () => {
    const pnl = calculatePositionPnl({ side: 'long', size: d('0.42'), entryPrice: usd('67000'), markPrice: usd('68000') });
    expect(pnl.toJSON().amount).toBe('420.00000000');
  });

  it('treats "buy" the same as "long"', () => {
    const pnl = calculatePositionPnl({ side: 'buy', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') });
    expect(pnl.toJSON().amount).toBe('10.00000000');
  });

  it('treats "sell" the same as "short"', () => {
    const pnl = calculatePositionPnl({ side: 'sell', size: d('1'), entryPrice: usd('100'), markPrice: usd('90') });
    expect(pnl.toJSON().amount).toBe('10.00000000');
  });

  it('throws on a cross-currency entry/mark price rather than silently mixing them', () => {
    expect(() =>
      calculatePositionPnl({ side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: Money.of('110', 'NGN') })
    ).toThrow(/Currency mismatch/);
  });
});

describe('calculatePositionPnlPct', () => {
  it('calculates percentage return correctly for a long', () => {
    const pct = calculatePositionPnlPct({ side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') });
    expect(pct).toBe(10);
  });

  it('returns 0 instead of throwing when entry value is 0', () => {
    const pct = calculatePositionPnlPct({ side: 'long', size: d('0'), entryPrice: usd('0'), markPrice: usd('110') });
    expect(pct).toBe(0);
    expect(Number.isNaN(pct)).toBe(false);
  });
});

describe('calculateTotalPnl', () => {
  it('sums P&L across multiple positions', () => {
    const total = calculateTotalPnl(
      [
        { side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') },
        { side: 'short', size: d('2'), entryPrice: usd('50'), markPrice: usd('45') },
      ],
      'USD'
    );
    // Position 1: +10, Position 2: +10 (2 * (50-45))
    expect(total.toJSON().amount).toBe('20.00000000');
  });

  it('skips positions with no mark price instead of throwing', () => {
    const total = calculateTotalPnl(
      [
        { side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: null },
        { side: 'long', size: d('1'), entryPrice: usd('100'), markPrice: usd('110') },
      ],
      'USD'
    );
    expect(total.toJSON().amount).toBe('10.00000000');
  });

  it('returns zero for an empty position list', () => {
    expect(calculateTotalPnl([], 'USD').toJSON().amount).toBe('0.00000000');
  });
});

describe('calculatePositionValue', () => {
  it('uses mark price when available', () => {
    const value = calculatePositionValue({ size: d('2'), markPrice: usd('100'), entryPrice: usd('90') });
    expect(value.toJSON().amount).toBe('200.00000000');
  });

  it('falls back to entry price when mark price is null', () => {
    const value = calculatePositionValue({ size: d('2'), markPrice: null, entryPrice: usd('90') });
    expect(value.toJSON().amount).toBe('180.00000000');
  });

  it('uses absolute size for short positions (negative size convention)', () => {
    const value = calculatePositionValue({ size: d('-2'), markPrice: usd('100'), entryPrice: usd('90') });
    expect(value.toJSON().amount).toBe('200.00000000');
  });
});

describe('calculateNetWorth', () => {
  it('sums position value and manual asset value', () => {
    const netWorth = calculateNetWorth(
      [{ size: d('1'), markPrice: usd('1000'), entryPrice: usd('900') }],
      [{ value: usd('5000') }],
      'USD'
    );
    expect(netWorth.toJSON().amount).toBe('6000.00000000');
  });

  it('returns zero when there are no positions or assets', () => {
    expect(calculateNetWorth([], [], 'USD').toJSON().amount).toBe('0.00000000');
  });

  it('handles multiple positions and assets together', () => {
    const netWorth = calculateNetWorth(
      [
        { size: d('1'), markPrice: usd('100'), entryPrice: usd('90') },
        { size: d('2'), markPrice: usd('50'), entryPrice: usd('45') },
      ],
      [{ value: usd('1000') }, { value: usd('2000') }],
      'USD'
    );
    // 100 + 100 + 1000 + 2000
    expect(netWorth.toJSON().amount).toBe('3200.00000000');
  });

  it('throws rather than silently mixing currencies across positions', () => {
    expect(() =>
      calculateNetWorth(
        [{ size: d('1'), markPrice: Money.of('1000', 'NGN'), entryPrice: Money.of('900', 'NGN') }],
        [],
        'USD'
      )
    ).toThrow(/Currency mismatch/);
  });

  it('10,000 sequential position additions of 0.00000001 sum exactly — the Money & Currency Layer D1 test case', () => {
    const positions = Array.from({ length: 10_000 }, () => ({
      size: d('1'),
      markPrice: usd('0.00000001'),
      entryPrice: usd('0'),
    }));
    const netWorth = calculateNetWorth(positions, [], 'USD');
    expect(netWorth.toJSON().amount).toBe('0.00010000');
  });
});

describe('calculateDayChange', () => {
  it('calculates positive day change correctly', () => {
    const change = calculateDayChange(usd('84320'), usd('82478'));
    expect(change.absolute.toJSON().amount).toBe('1842.00000000');
    expect(change.percentage).toBeCloseTo(2.233, 2);
  });

  it('calculates negative day change correctly', () => {
    const change = calculateDayChange(usd('80000'), usd('82000'));
    expect(change.absolute.toJSON().amount).toBe('-2000.00000000');
    expect(change.percentage).toBeCloseTo(-2.439, 2);
  });

  it('returns 0% change instead of throwing when yesterday was 0', () => {
    const change = calculateDayChange(usd('100'), usd('0'));
    expect(change.percentage).toBe(0);
    expect(Number.isFinite(change.percentage)).toBe(true);
  });
});

describe('calculateAllocation', () => {
  it('calculates percentages that sum to 100', () => {
    const alloc = calculateAllocation({ crypto: usd('52'), forex: usd('28'), gold: usd('14'), cash: usd('6') });
    const sum = alloc.crypto + alloc.forex + alloc.gold + alloc.cash;
    expect(sum).toBeCloseTo(100, 5);
    expect(alloc.crypto).toBe(52);
  });

  it('returns all zeros instead of NaN when total is 0', () => {
    const alloc = calculateAllocation({ crypto: usd('0'), forex: usd('0'), gold: usd('0'), cash: usd('0') });
    expect(alloc).toEqual({ crypto: 0, forex: 0, gold: 0, cash: 0 });
  });
});

describe('calculatePodProgress', () => {
  it('calculates progress percentage correctly', () => {
    expect(calculatePodProgress(usd('6840'), usd('10000'))).toBe(68.4);
  });

  it('clamps progress at 100 when current exceeds target', () => {
    expect(calculatePodProgress(usd('15000'), usd('10000'))).toBe(100);
  });

  it('returns 0 when target is 0 instead of dividing by zero', () => {
    expect(calculatePodProgress(usd('500'), usd('0'))).toBe(0);
  });

  it('returns 0 for a brand new pod with no contributions', () => {
    expect(calculatePodProgress(usd('0'), usd('5000'))).toBe(0);
  });
});

describe('calculateMarginUtilization', () => {
  it('calculates margin utilization percentage', () => {
    expect(calculateMarginUtilization(usd('28668'), usd('84320'))).toBeCloseTo(34.0, 1);
  });

  it('clamps at 100 even if margin used exceeds equity', () => {
    expect(calculateMarginUtilization(usd('100000'), usd('50000'))).toBe(100);
  });

  it('returns 0 when total equity is 0 or negative', () => {
    expect(calculateMarginUtilization(usd('1000'), usd('0'))).toBe(0);
    expect(calculateMarginUtilization(usd('1000'), Money.of('-500', 'USD'))).toBe(0);
  });
});
