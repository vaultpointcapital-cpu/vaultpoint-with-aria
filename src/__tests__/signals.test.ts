import { describe, it, expect } from 'vitest';
import { executeSignalSchema, describeSignal, computeTrackRecord } from '@/lib/validations/signals';

describe('executeSignalSchema', () => {
  it('accepts a valid execution request', () => {
    const result = executeSignalSchema.safeParse({
      brokerConnectionId: '11111111-1111-1111-1111-111111111111',
      size: 0.01,
    });
    expect(result.success).toBe(true);
  });

  it('coerces a numeric string size', () => {
    const result = executeSignalSchema.safeParse({
      brokerConnectionId: '11111111-1111-1111-1111-111111111111',
      size: '0.5',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.size).toBe(0.5);
  });

  it('rejects a non-uuid broker connection id', () => {
    const result = executeSignalSchema.safeParse({ brokerConnectionId: 'not-a-uuid', size: 0.01 });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative size', () => {
    expect(
      executeSignalSchema.safeParse({
        brokerConnectionId: '11111111-1111-1111-1111-111111111111',
        size: 0,
      }).success
    ).toBe(false);
    expect(
      executeSignalSchema.safeParse({
        brokerConnectionId: '11111111-1111-1111-1111-111111111111',
        size: -1,
      }).success
    ).toBe(false);
  });
});

describe('describeSignal', () => {
  it('formats a long signal', () => {
    expect(
      describeSignal({
        pair: 'BTCUSDT',
        direction: 'long',
        entry_price: 65000,
        stop_loss: 63000,
        take_profit: 70000,
        risk_reward_ratio: 2.5,
      })
    ).toBe('Long BTCUSDT — entry 65,000, SL 63,000, TP 70,000 (R:R 2.5)');
  });

  it('formats a short signal', () => {
    expect(
      describeSignal({
        pair: 'ETHUSDT',
        direction: 'short',
        entry_price: 3000,
        stop_loss: 3200,
        take_profit: 2600,
        risk_reward_ratio: 2,
      })
    ).toBe('Short ETHUSDT — entry 3,000, SL 3,200, TP 2,600 (R:R 2.0)');
  });
});

describe('computeTrackRecord', () => {
  it('returns null rates with no closed signals', () => {
    const result = computeTrackRecord([]);
    expect(result).toEqual({
      totalClosed: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRatePct: null,
      avgRMultiple: null,
    });
  });

  it('computes win rate and average R across mixed outcomes', () => {
    const result = computeTrackRecord([
      { result: 'win', realized_r_multiple: 2 },
      { result: 'win', realized_r_multiple: 3 },
      { result: 'loss', realized_r_multiple: -1 },
      { result: 'breakeven', realized_r_multiple: 0 },
    ]);

    expect(result.totalClosed).toBe(4);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
    expect(result.breakevens).toBe(1);
    expect(result.winRatePct).toBe(50);
    expect(result.avgRMultiple).toBe(1); // (2 + 3 - 1 + 0) / 4
  });

  it('excludes null realized_r_multiple values from the average without treating them as zero', () => {
    const result = computeTrackRecord([
      { result: 'win', realized_r_multiple: 4 },
      { result: 'win', realized_r_multiple: null },
    ]);

    // If the null were coerced to 0, the average would be 2, not 4.
    expect(result.avgRMultiple).toBe(4);
    expect(result.winRatePct).toBe(100);
  });

  it('reports null avgRMultiple when every outcome has a null r-multiple', () => {
    const result = computeTrackRecord([{ result: 'loss', realized_r_multiple: null }]);
    expect(result.avgRMultiple).toBeNull();
  });
});
