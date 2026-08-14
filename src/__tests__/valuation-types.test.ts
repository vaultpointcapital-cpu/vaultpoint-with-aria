import { describe, it, expect } from 'vitest';
import { countsTowardNetWorth, type Holding } from '@/lib/valuation/types';
import { Money } from '@/lib/money';

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 'h1',
    userId: 'user-1',
    sourceType: 'position',
    sourceId: 'p1',
    label: 'BTC/USDT',
    assetClass: 'crypto',
    value: Money.of('100', 'USD'),
    costBasis: null,
    reality: 'real',
    liquidity: 'liquid',
    provenance: 'broker_api',
    asOf: new Date(),
    stale: false,
    ...overrides,
  };
}

describe('countsTowardNetWorth', () => {
  it('includes a real holding', () => {
    expect(countsTowardNetWorth(holding({ reality: 'real' }))).toBe(true);
  });

  it('excludes a simulated holding — non-negotiable', () => {
    expect(countsTowardNetWorth(holding({ reality: 'simulated' }))).toBe(false);
  });

  it('excludes a pending holding', () => {
    expect(countsTowardNetWorth(holding({ reality: 'pending' }))).toBe(false);
  });
});
