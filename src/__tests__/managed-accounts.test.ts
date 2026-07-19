import { describe, it, expect } from 'vitest';
import { computeAccountStats, computeDistributionBreakdown, isEligibleForManagedTier } from '@/lib/validations/managed-accounts';

describe('isEligibleForManagedTier', () => {
  it('allows a Pro user into bronze and silver but not gold', () => {
    expect(isEligibleForManagedTier('pro', 'bronze')).toBe(true);
    expect(isEligibleForManagedTier('pro', 'silver')).toBe(true);
    expect(isEligibleForManagedTier('pro', 'gold')).toBe(false);
  });

  it('allows an Elite user into every tier', () => {
    expect(isEligibleForManagedTier('elite', 'bronze')).toBe(true);
    expect(isEligibleForManagedTier('elite', 'gold')).toBe(true);
  });

  it('blocks a Free user from every tier', () => {
    expect(isEligibleForManagedTier('free', 'bronze')).toBe(false);
  });
});

describe('computeAccountStats', () => {
  it('returns the starting capital with zero P&L and zero drawdown when there are no trades', () => {
    const result = computeAccountStats(10000, [], null);
    expect(result).toEqual({
      currentBalance: 10000,
      allTimePnl: 0,
      pnlSinceLastDistribution: 0,
      peakBalance: 10000,
      drawdownPct: 0,
    });
  });

  it('sums realized P&L across trades into the running balance', () => {
    const result = computeAccountStats(10000, [
      { realized_pnl: 500, closed_at: '2026-06-01T00:00:00Z' },
      { realized_pnl: -200, closed_at: '2026-06-05T00:00:00Z' },
      { realized_pnl: 300, closed_at: '2026-06-10T00:00:00Z' },
    ], null);

    expect(result.currentBalance).toBe(10600);
    expect(result.allTimePnl).toBe(600);
  });

  it('tracks peak-to-current drawdown, not peak-to-lowest', () => {
    // Balance path: 10000 -> 11000 (peak) -> 9000 (trough, -18.2% dd) -> 10500 (recovers to -4.5% dd)
    const result = computeAccountStats(10000, [
      { realized_pnl: 1000, closed_at: '2026-06-01T00:00:00Z' },
      { realized_pnl: -2000, closed_at: '2026-06-05T00:00:00Z' },
      { realized_pnl: 1500, closed_at: '2026-06-10T00:00:00Z' },
    ], null);

    expect(result.peakBalance).toBe(11000);
    expect(result.currentBalance).toBe(10500);
    // Drawdown is measured from the peak to the CURRENT balance (10500),
    // not the trough (9000) — a recovered account shouldn't still show
    // its worst historical drawdown as the current figure.
    expect(result.drawdownPct).toBeCloseTo(((11000 - 10500) / 11000) * 100, 5);
  });

  it('only counts trades closed on or after the last distribution toward pnlSinceLastDistribution', () => {
    const result = computeAccountStats(10000, [
      { realized_pnl: 500, closed_at: '2026-05-15T00:00:00Z' }, // before the cutoff
      { realized_pnl: 300, closed_at: '2026-06-05T00:00:00Z' }, // after the cutoff
      { realized_pnl: 200, closed_at: '2026-06-10T00:00:00Z' }, // after the cutoff
    ], '2026-06-01');

    expect(result.allTimePnl).toBe(1000); // all three still count toward all-time
    expect(result.pnlSinceLastDistribution).toBe(500); // only the two after period_end
  });

  it('ignores trades with no realized outcome yet (still open)', () => {
    const result = computeAccountStats(10000, [
      { realized_pnl: 500, closed_at: '2026-06-01T00:00:00Z' },
      { realized_pnl: null, closed_at: null },
    ], null);

    expect(result.currentBalance).toBe(10500);
  });

  it('never reports negative drawdown for a peak balance of zero', () => {
    const result = computeAccountStats(0, [], null);
    expect(result.drawdownPct).toBe(0);
  });
});

describe('computeDistributionBreakdown', () => {
  it('splits a positive gross P&L by the tier profit split percentage', () => {
    const result = computeDistributionBreakdown(1000, 20);
    expect(result).toEqual({ grossPnl: 1000, clientSharePct: 80, clientShare: 800, vaultpointShare: 200 });
  });

  it('rounds to the nearest cent', () => {
    const result = computeDistributionBreakdown(100.01, 30);
    // vaultpointShare = round(100.01 * 0.30 * 100) / 100 = round(3000.3) / 100 = 30.00
    // clientShare = round((100.01 - 30) * 100) / 100 = 70.01
    expect(result.vaultpointShare).toBe(30);
    expect(result.clientShare).toBe(70.01);
    expect(result.clientShare + result.vaultpointShare).toBeCloseTo(100.01, 5);
  });

  it('gives the client 100% of a zero-or-negative gross P&L — VaultPoint never splits a loss', () => {
    expect(computeDistributionBreakdown(0, 25)).toEqual({
      grossPnl: 0,
      clientSharePct: 100,
      clientShare: 0,
      vaultpointShare: 0,
    });
    expect(computeDistributionBreakdown(-500, 25)).toEqual({
      grossPnl: -500,
      clientSharePct: 100,
      clientShare: -500,
      vaultpointShare: 0,
    });
  });
});
