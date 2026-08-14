import { describe, it, expect } from 'vitest';
import { Money, moneyFromJSON } from '@/lib/money';

describe('Money.plus', () => {
  it('adds 0.1 + 0.2 exactly, unlike raw JS floats', () => {
    const result = Money.of('0.1', 'USD').plus(Money.of('0.2', 'USD'));
    expect(result.toJSON().amount).toBe('0.30000000');
    // The actual bug this class exists to prevent:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('throws on a cross-currency addition rather than silently combining them', () => {
    expect(() => Money.of('10', 'USD').plus(Money.of('10', 'NGN'))).toThrow(/Currency mismatch/);
  });

  it('sums 10,000 additions of 0.00000001 with no drift', () => {
    let total = Money.zero('USD');
    for (let i = 0; i < 10_000; i++) {
      total = total.plus(Money.of('0.00000001', 'USD'));
    }
    expect(total.toJSON().amount).toBe('0.00010000');
  });
});

describe('Money.minus', () => {
  it('subtracts exactly', () => {
    const result = Money.of('5.30', 'USD').minus(Money.of('1.10', 'USD'));
    expect(result.toJSON().amount).toBe('4.20000000');
  });

  it('throws on a cross-currency subtraction', () => {
    expect(() => Money.of('10', 'USD').minus(Money.of('5', 'NGN'))).toThrow(/Currency mismatch/);
  });
});

describe('Money.times', () => {
  it('scales by a scalar factor', () => {
    const result = Money.of('100', 'USD').times('1.5');
    expect(result.toJSON().amount).toBe('150.00000000');
  });
});

describe('Money.ratioTo', () => {
  it('returns a dimensionless ratio for same-currency amounts', () => {
    const ratio = Money.of('50', 'USD').ratioTo(Money.of('200', 'USD'));
    expect(ratio.toNumber()).toBe(0.25);
  });

  it('throws on a cross-currency ratio', () => {
    expect(() => Money.of('50', 'USD').ratioTo(Money.of('200', 'NGN'))).toThrow(/Currency mismatch/);
  });

  it('throws dividing by zero rather than returning Infinity', () => {
    expect(() => Money.of('50', 'USD').ratioTo(Money.zero('USD'))).toThrow();
  });
});

describe('Money.format', () => {
  it('formats a standard currency at 2 decimal places', () => {
    expect(Money.of('84320', 'USD').format('en-US')).toBe('$84,320.00');
  });

  it('formats a zero-decimal currency (e.g. JPY) with no decimal places', () => {
    expect(Money.of('1000', 'JPY').format('en-US')).toBe('¥1,000');
  });

  it('rounds half-up at the display edge only, keeping full precision internally', () => {
    const money = Money.of('10.005', 'USD');
    expect(money.toJSON().amount).toBe('10.00500000');
    expect(money.format('en-US')).toBe('$10.01');
  });
});

describe('Money.toJSON / moneyFromJSON round-trip', () => {
  it('preserves all 8 decimal places through a round trip', () => {
    const original = Money.of('123.45678912', 'USDT');
    const json = original.toJSON();
    const restored = moneyFromJSON(json);
    expect(restored.toJSON()).toEqual(json);
    expect(json.amount).toBe('123.45678912');
  });
});

describe('Money.of', () => {
  it('rejects a non-integer raw number, requiring a string instead', () => {
    expect(() => Money.of(10.5, 'USD')).toThrow(/non-integer number/);
  });

  it('accepts a safe integer number', () => {
    expect(Money.of(100, 'USD').toJSON().amount).toBe('100.00000000');
  });
});

describe('Money.isZero / isNegative', () => {
  it('identifies zero amounts', () => {
    expect(Money.zero('USD').isZero()).toBe(true);
    expect(Money.of('1', 'USD').isZero()).toBe(false);
  });

  it('identifies negative amounts', () => {
    expect(Money.of('-1', 'USD').isNegative()).toBe(true);
    expect(Money.of('1', 'USD').isNegative()).toBe(false);
  });
});
