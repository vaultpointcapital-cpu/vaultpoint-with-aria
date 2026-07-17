import { describe, it, expect } from 'vitest';
import {
  createAlertSchema,
  updateAlertSchema,
  canCreateAnotherAlert,
  describeAlert,
  ALERT_LIMITS_BY_TIER,
} from '@/lib/validations/alerts';

describe('createAlertSchema', () => {
  it('accepts a valid price alert with a symbol', () => {
    const result = createAlertSchema.safeParse({
      symbol: 'btcusdt',
      conditionType: 'price',
      operator: 'above',
      threshold: 100000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.symbol).toBe('BTCUSDT'); // uppercased
    }
  });

  it('accepts a valid portfolio-wide alert with a null symbol', () => {
    const result = createAlertSchema.safeParse({
      symbol: null,
      conditionType: 'pnl_pct',
      operator: 'below',
      threshold: 10,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a price alert with no symbol', () => {
    const result = createAlertSchema.safeParse({
      symbol: null,
      conditionType: 'price',
      operator: 'above',
      threshold: 100000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a portfolio-wide alert that specifies a symbol', () => {
    const result = createAlertSchema.safeParse({
      symbol: 'BTCUSDT',
      conditionType: 'pnl_pct',
      operator: 'below',
      threshold: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero threshold', () => {
    const result = createAlertSchema.safeParse({
      symbol: 'BTCUSDT',
      conditionType: 'price',
      operator: 'above',
      threshold: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative threshold', () => {
    const result = createAlertSchema.safeParse({
      symbol: null,
      conditionType: 'margin_pct',
      operator: 'above',
      threshold: -5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid condition type', () => {
    const result = createAlertSchema.safeParse({
      symbol: null,
      conditionType: 'liquidation_risk',
      operator: 'above',
      threshold: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid operator', () => {
    const result = createAlertSchema.safeParse({
      symbol: 'BTCUSDT',
      conditionType: 'price',
      operator: 'equal',
      threshold: 100000,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateAlertSchema', () => {
  it('accepts toggling isActive alone', () => {
    expect(updateAlertSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('accepts updating threshold alone', () => {
    expect(updateAlertSchema.safeParse({ threshold: 50 }).success).toBe(true);
  });

  it('accepts an empty object (no-op update)', () => {
    expect(updateAlertSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a non-positive threshold', () => {
    expect(updateAlertSchema.safeParse({ threshold: 0 }).success).toBe(false);
  });
});

describe('canCreateAnotherAlert', () => {
  it('blocks free tier at the limit', () => {
    expect(canCreateAnotherAlert('free', ALERT_LIMITS_BY_TIER.free)).toBe(false);
  });

  it('allows free tier below the limit', () => {
    expect(canCreateAnotherAlert('free', ALERT_LIMITS_BY_TIER.free - 1)).toBe(true);
  });

  it('always allows pro tier', () => {
    expect(canCreateAnotherAlert('pro', 1000)).toBe(true);
  });

  it('always allows elite tier', () => {
    expect(canCreateAnotherAlert('elite', 1000)).toBe(true);
  });
});

describe('describeAlert', () => {
  it('describes a price alert', () => {
    expect(
      describeAlert({ symbol: 'BTCUSDT', condition_type: 'price', operator: 'above', threshold: 100000 })
    ).toBe('Alert when BTCUSDT crosses above $100,000');
  });

  it('describes a portfolio P&L percentage alert', () => {
    expect(
      describeAlert({ symbol: null, condition_type: 'pnl_pct', operator: 'below', threshold: 10 })
    ).toBe('Alert when portfolio P&L crosses below 10%');
  });

  it('describes a portfolio P&L dollar alert', () => {
    expect(
      describeAlert({ symbol: null, condition_type: 'pnl_abs', operator: 'below', threshold: 5000 })
    ).toBe('Alert when portfolio P&L crosses below $5,000');
  });

  it('describes a margin utilization alert', () => {
    expect(
      describeAlert({ symbol: null, condition_type: 'margin_pct', operator: 'above', threshold: 80 })
    ).toBe('Alert when margin utilization crosses above 80%');
  });

  it('describes a drawdown alert', () => {
    expect(
      describeAlert({ symbol: null, condition_type: 'drawdown_pct', operator: 'above', threshold: 20 })
    ).toBe('Alert when portfolio drawdown crosses above 20%');
  });
});

describe('createAlertSchema — drawdown_pct', () => {
  it('accepts a portfolio-wide drawdown alert', () => {
    const result = createAlertSchema.safeParse({
      symbol: null,
      conditionType: 'drawdown_pct',
      operator: 'above',
      threshold: 20,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a drawdown alert with a symbol attached', () => {
    const result = createAlertSchema.safeParse({
      symbol: 'BTCUSDT',
      conditionType: 'drawdown_pct',
      operator: 'above',
      threshold: 20,
    });
    expect(result.success).toBe(false);
  });
});
