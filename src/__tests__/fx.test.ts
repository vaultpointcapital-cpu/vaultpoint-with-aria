import { describe, it, expect, vi } from 'vitest';
import { Money } from '@/lib/money';

interface FakeFxRow {
  currency: string;
  rate_to_usd: string;
  source: string;
  fetched_at: string;
}

let fxRows: FakeFxRow[] = [];

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

// No Redis configured in this test environment — forces every getRate()
// through the DB-fallback path, which is what's actually under test here.
vi.mock('@/lib/redis', () => ({ redis: null }));

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('FxService.getRate', () => {
  it('returns rate 1 for USD without touching the DB', async () => {
    fxRows = [];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('USD');
    expect(rate.rateToUsd.toString()).toBe('1');
    expect(rate.stale).toBe(false);
  });

  it('returns the latest rate for a currency, not stale when recent', async () => {
    fxRows = [{ currency: 'NGN', rate_to_usd: '0.00065', source: 'cbn_official', fetched_at: hoursAgo(1) }];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('NGN');
    expect(rate.rateToUsd.toString()).toBe('0.00065');
    expect(rate.stale).toBe(false);
  });

  it('marks a rate older than 24h as stale but still returns it', async () => {
    fxRows = [{ currency: 'GBP', rate_to_usd: '1.27', source: 'openexchangerates', fetched_at: hoursAgo(30) }];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('GBP');
    expect(rate.rateToUsd.toString()).toBe('1.27');
    expect(rate.stale).toBe(true);
  });

  it('throws FxRateUnavailableError when no rate exists — never fabricates one', async () => {
    fxRows = [];
    const { fxService, FxRateUnavailableError } = await import('@/lib/fx');
    await expect(fxService.getRate('KES')).rejects.toThrow(FxRateUnavailableError);
  });

  it('§6: prefers a recent parallel-market NGN rate over the official one', async () => {
    fxRows = [
      { currency: 'NGN', rate_to_usd: '0.00062', source: 'cbn_official', fetched_at: hoursAgo(2) },
      { currency: 'NGN', rate_to_usd: '0.00058', source: 'parallel_market', fetched_at: hoursAgo(1) },
    ];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('NGN');
    expect(rate.rateToUsd.toString()).toBe('0.00058');
    expect(rate.basis).toBe('parallel_market');
  });

  it('§6: falls back to the official NGN rate when no recent parallel-market row exists', async () => {
    fxRows = [{ currency: 'NGN', rate_to_usd: '0.00062', source: 'cbn_official', fetched_at: hoursAgo(1) }];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('NGN');
    expect(rate.rateToUsd.toString()).toBe('0.00062');
    expect(rate.basis).toBe('cbn_official');
  });

  it('a stablecoin depeg converts at its live rate, never a hardcoded 1.00 peg', async () => {
    fxRows = [{ currency: 'USDT', rate_to_usd: '0.94', source: 'coingecko', fetched_at: hoursAgo(0.1) }];
    const { fxService } = await import('@/lib/fx');
    const rate = await fxService.getRate('USDT');
    expect(rate.rateToUsd.toString()).toBe('0.94');
  });
});

describe('FxService.getRates', () => {
  it('returns a partial map — a currency with no rate is simply absent, never thrown for the whole batch', async () => {
    fxRows = [{ currency: 'NGN', rate_to_usd: '0.00065', source: 'cbn_official', fetched_at: hoursAgo(1) }];
    const { fxService } = await import('@/lib/fx');
    const rates = await fxService.getRates(['USD', 'NGN', 'KES']);
    expect(rates.has('USD')).toBe(true);
    expect(rates.has('NGN')).toBe(true);
    expect(rates.has('KES')).toBe(false);
  });
});

describe('FxService.convertAt', () => {
  it('is deterministic across repeated calls with the same rate map', async () => {
    const { fxService } = await import('@/lib/fx');
    const rates = { NGN: '0.00065' };
    const money = Money.of('1000000', 'NGN');

    const first = fxService.convertAt(money, 'USD', rates);
    const second = fxService.convertAt(money, 'USD', rates);

    expect(first.toJSON()).toEqual(second.toJSON());
  });

  it('reproduces a historical figure even after "today\'s" rate moves — the D7 guarantee', async () => {
    const { fxService } = await import('@/lib/fx');
    const snapshotRates = { NGN: '0.00065' }; // rate at snapshot time
    const todayRates = { NGN: '0.00039' }; // a simulated ~40% NGN move since then
    const money = Money.of('1000000', 'NGN');

    const historical = fxService.convertAt(money, 'USD', snapshotRates);
    const recomputedAgainstSnapshot = fxService.convertAt(money, 'USD', snapshotRates);
    const recomputedAgainstToday = fxService.convertAt(money, 'USD', todayRates);

    expect(recomputedAgainstSnapshot.toJSON()).toEqual(historical.toJSON());
    expect(recomputedAgainstToday.toJSON()).not.toEqual(historical.toJSON());
  });

  it('throws when the rate map is missing a currency it needs, rather than fabricating one', async () => {
    const { fxService } = await import('@/lib/fx');
    expect(() => fxService.convertAt(Money.of('100', 'GBP'), 'USD', {})).toThrow(/No FX rate available/);
  });

  it('is a no-op when converting to the same currency', async () => {
    const { fxService } = await import('@/lib/fx');
    const money = Money.of('100', 'USD');
    expect(fxService.convertAt(money, 'USD', {}).toJSON()).toEqual(money.toJSON());
  });
});

describe('FxService.convert', () => {
  it('converts through USD (D5) using live DB-backed rates', async () => {
    fxRows = [
      { currency: 'NGN', rate_to_usd: '0.00065', source: 'cbn_official', fetched_at: hoursAgo(1) },
      { currency: 'GBP', rate_to_usd: '1.27', source: 'openexchangerates', fetched_at: hoursAgo(1) },
    ];
    const { fxService } = await import('@/lib/fx');
    const { money, stale } = await fxService.convert(Money.of('1000000', 'NGN'), 'GBP');

    // 1,000,000 NGN -> 650 USD -> 650/1.27 GBP
    expect(Number(money.toJSON().amount)).toBeCloseTo(650 / 1.27, 2);
    expect(money.toJSON().currency).toBe('GBP');
    expect(stale).toBe(false);
  });
});
