import { describe, it, expect, vi } from 'vitest';
import { Money } from '@/lib/money';
import type { Holding, HoldingProvider } from '@/lib/valuation/types';

interface FakeFxRow {
  currency: string;
  rate_to_usd: string;
  source: string;
  fetched_at: string;
}

let fxRows: FakeFxRow[] = [];
let fakeHoldings: Holding[] = [];

function makeFakeSupabaseClient() {
  return {
    from: (table: string) => {
      if (table !== 'fx_rates') throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          const filters: Array<[string, string]> = [];
          const builder = {
            eq: (col: string, val: string) => {
              filters.push([col, val]);
              return builder;
            },
            order: () => builder,
            limit: () => builder,
            maybeSingle: async () => {
              const matches = fxRows
                .filter((r) => filters.every(([col, val]) => (r as unknown as Record<string, string>)[col] === val))
                .sort((a, b) => new Date(b.fetched_at).getTime() - new Date(a.fetched_at).getTime());
              return { data: matches[0] ?? null, error: null };
            },
          };
          return builder;
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => makeFakeSupabaseClient(),
}));

vi.mock('@/lib/redis', () => ({ redis: null }));

// A single fake HoldingProvider standing in for the whole registry — tests
// control exactly what it returns via the module-level `fakeHoldings`
// array, rather than exercising each real provider's own Supabase query
// (those are covered by their own construction, not the aggregator's job).
vi.mock('@/lib/valuation/registry', () => ({
  HOLDING_PROVIDERS: [
    {
      sourceType: 'fake',
      list: async () => fakeHoldings,
    } satisfies HoldingProvider,
  ],
}));

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
    asOf: new Date('2026-08-01T00:00:00Z'),
    stale: false,
    ...overrides,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('calculateNetWorthResult', () => {
  it('excludes a simulated holding from the total but still returns it in `excluded`', async () => {
    fxRows = [];
    fakeHoldings = [
      holding({ id: 'live', value: Money.of('1000', 'USD'), reality: 'real' }),
      holding({ id: 'prop', value: Money.of('50000', 'USD'), reality: 'simulated', sourceType: 'prop_account' }),
    ];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    expect(result.total.toJSON().amount).toBe('1000.00000000');
    expect(result.included.map((h) => h.id)).toEqual(['live']);
    expect(result.excluded.map((h) => h.id)).toEqual(['prop']);
    expect(result.excluded[0]?.valueInDisplayCurrency?.toJSON().amount).toBe('50000.00000000');
  });

  it('an unpriced holding is absent from the total and never zeroed', async () => {
    fxRows = []; // no NGN rate available at all
    fakeHoldings = [
      holding({ id: 'usd-holding', value: Money.of('1000', 'USD') }),
      holding({ id: 'ngn-holding', value: Money.of('500000', 'NGN'), label: 'Lagos savings' }),
    ];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    // Only the priceable holding counts — the total is NOT zero for the
    // unpriced one, it's simply absent, and named.
    expect(result.total.toJSON().amount).toBe('1000.00000000');
    expect(result.unpriced.map((h) => h.id)).toEqual(['ngn-holding']);
    expect(result.included.map((h) => h.id)).toEqual(['usd-holding']);
  });

  it('asOf reflects the oldest included holding, not the newest', async () => {
    fxRows = [];
    fakeHoldings = [
      holding({ id: 'old', asOf: new Date('2026-01-01T00:00:00Z') }),
      holding({ id: 'new', asOf: new Date('2026-08-01T00:00:00Z') }),
    ];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    expect(result.asOf.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a stale holding sets stale: true on the result', async () => {
    fxRows = [];
    fakeHoldings = [holding({ stale: true })];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    expect(result.stale).toBe(true);
  });

  it('a stale FX rate sets stale: true on the result even if every holding itself is fresh', async () => {
    fxRows = [{ currency: 'NGN', rate_to_usd: '0.00065', source: 'cbn_official', fetched_at: hoursAgo(30) }];
    fakeHoldings = [holding({ value: Money.of('100000', 'NGN'), stale: false })];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    expect(result.stale).toBe(true);
  });

  it('totals correctly across a mixed-currency portfolio against fixed rates', async () => {
    fxRows = [
      { currency: 'NGN', rate_to_usd: '0.00065', source: 'cbn_official', fetched_at: hoursAgo(1) },
      { currency: 'USDT', rate_to_usd: '0.999', source: 'coingecko', fetched_at: hoursAgo(1) },
    ];
    fakeHoldings = [
      holding({ id: 'usd', value: Money.of('1000', 'USD') }),
      holding({ id: 'ngn', value: Money.of('1000000', 'NGN') }),
      holding({ id: 'usdt', value: Money.of('500', 'USDT') }),
    ];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    // 1000 USD + (1,000,000 * 0.00065) NGN->USD + (500 * 0.999) USDT->USD
    const expected = 1000 + 1_000_000 * 0.00065 + 500 * 0.999;
    expect(Number(result.total.toJSON().amount)).toBeCloseTo(expected, 6);
  });

  it('groups included holdings by assetClass and liquidity', async () => {
    fxRows = [];
    fakeHoldings = [
      holding({ id: 'a', value: Money.of('100', 'USD'), assetClass: 'crypto', liquidity: 'liquid' }),
      holding({ id: 'b', value: Money.of('200', 'USD'), assetClass: 'savings_pod', liquidity: 'semi_liquid' }),
    ];
    const { calculateNetWorthResult } = await import('@/lib/valuation/networth');

    const result = await calculateNetWorthResult('user-1', 'USD');

    expect(result.byAssetClass.get('crypto')?.toJSON().amount).toBe('100.00000000');
    expect(result.byAssetClass.get('savings_pod')?.toJSON().amount).toBe('200.00000000');
    expect(result.byLiquidity.get('liquid')?.toJSON().amount).toBe('100.00000000');
    expect(result.byLiquidity.get('semi_liquid')?.toJSON().amount).toBe('200.00000000');
  });
});
