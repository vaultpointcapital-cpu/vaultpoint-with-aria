import Decimal from 'decimal.js';
import { redis } from '@/lib/redis';
import { createServiceClient } from '@/lib/supabase/server';
import { Money, type CurrencyCode } from '@/lib/money';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export class FxRateUnavailableError extends Error {
  constructor(readonly currency: string) {
    super(`No FX rate available for ${currency}`);
    this.name = 'FxRateUnavailableError';
  }
}

export interface FxRate {
  readonly currency: CurrencyCode;
  readonly rateToUsd: Decimal;
  readonly fetchedAt: Date;
  readonly stale: boolean;
  /** NGN only (§6) — which rate this is, for the UI's disclosure note.
   * Provisional pending founder sign-off — see fx_service.py. */
  readonly basis?: 'cbn_official' | 'parallel_market';
}

interface RedisFxPayload {
  rate: string;
  fetchedAt: string;
  source: string;
}

/**
 * Reader half of the Money & Currency Layer's FX service. The producer
 * (fetching real rates from Binance/Open Exchange Rates and populating
 * Redis + fx_rates) is services/broker-sync/app/fx_service.py, a
 * scheduled job — this class only ever reads what that job already wrote,
 * same reader/producer split as everything else sharing this Upstash
 * instance.
 */
export class FxService {
  async getRate(currency: string): Promise<FxRate> {
    if (currency === 'USD') {
      return { currency: currency as CurrencyCode, rateToUsd: new Decimal(1), fetchedAt: new Date(), stale: false };
    }

    if (redis) {
      const cached = await redis.get<RedisFxPayload>(`fx:${currency}`);
      if (cached) {
        return {
          currency: currency as CurrencyCode,
          rateToUsd: new Decimal(cached.rate),
          fetchedAt: new Date(cached.fetchedAt),
          stale: false,
        };
      }
    }

    return this.getRateFromDb(currency);
  }

  private async getRateFromDb(currency: string): Promise<FxRate> {
    const supabase = createServiceClient();

    // NGN dual-rate handling (§6, provisional pending founder sign-off):
    // prefer a recent parallel-market row — that's the rate a Lagos user
    // can actually transact at — over the official/CBN-adjacent one.
    if (currency === 'NGN') {
      const { data: parallel } = await supabase
        .from('fx_rates')
        .select('rate_to_usd, fetched_at, source')
        .eq('currency', 'NGN')
        .eq('source', 'parallel_market')
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (parallel && Date.now() - new Date(parallel.fetched_at).getTime() <= STALE_AFTER_MS) {
        return {
          currency: currency as CurrencyCode,
          rateToUsd: new Decimal(parallel.rate_to_usd),
          fetchedAt: new Date(parallel.fetched_at),
          stale: false,
          basis: 'parallel_market',
        };
      }
    }

    const { data } = await supabase
      .from('fx_rates')
      .select('rate_to_usd, fetched_at, source')
      .eq('currency', currency)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      throw new FxRateUnavailableError(currency);
    }

    const stale = Date.now() - new Date(data.fetched_at).getTime() > STALE_AFTER_MS;
    return {
      currency: currency as CurrencyCode,
      rateToUsd: new Decimal(data.rate_to_usd),
      fetchedAt: new Date(data.fetched_at),
      stale,
      basis: currency === 'NGN' ? 'cbn_official' : undefined,
    };
  }

  /**
   * Best-effort bulk fetch — a currency with no available rate is simply
   * absent from the returned map, never thrown for or silently zeroed.
   * Callers building an aggregate (e.g. net worth) must check
   * `!rates.has(currency)` and report that holding as unpriced (spec §5:
   * "Never fabricate a rate... the aggregate returns a partial result
   * with the unpriced holdings listed, not a silently-omitted or
   * zero-valued asset").
   */
  async getRates(currencies: readonly string[]): Promise<ReadonlyMap<string, FxRate>> {
    const unique = Array.from(new Set(currencies));
    const results = await Promise.all(
      unique.map(async (currency) => {
        try {
          return [currency, await this.getRate(currency)] as const;
        } catch (err) {
          if (err instanceof FxRateUnavailableError) return null;
          throw err;
        }
      })
    );
    return new Map(results.filter((r): r is readonly [string, FxRate] => r !== null));
  }

  /** Live conversion — goes through USD (D5: n rates, not n²). */
  async convert(money: Money, to: string): Promise<{ money: Money; stale: boolean }> {
    if (money.currency === to) {
      return { money, stale: false };
    }

    const fromRate = money.currency === 'USD' ? null : await this.getRate(money.currency);
    const toRate = to === 'USD' ? null : await this.getRate(to);

    const usdAmount = fromRate ? money.times(fromRate.rateToUsd) : money;
    const converted = toRate ? usdAmount.dividedBy(toRate.rateToUsd) : usdAmount;
    // dividedBy/times preserve the source currency tag — reconstruct with
    // the actual target currency now that the math is done.
    const result = Money.of(converted.toJSON().amount, to);

    return { money: result, stale: Boolean(fromRate?.stale || toRate?.stale) };
  }

  /**
   * Deterministic conversion against a stored snapshot's rate map — takes
   * no clock and no network. This is what makes historical net worth
   * reproducible (D7): every historical read path must use this, never
   * convert().
   */
  convertAt(money: Money, to: string, rates: Record<string, string>): Money {
    if (money.currency === to) {
      return money;
    }

    const rateFor = (currency: string): Decimal => {
      if (currency === 'USD') return new Decimal(1);
      const rate = rates[currency];
      if (!rate) throw new FxRateUnavailableError(currency);
      return new Decimal(rate);
    };

    // .times()/.dividedBy() preserve the source currency tag on the
    // intermediate USD-valued amount — harmless (it's discarded, never
    // combined with another Money), but re-tagged explicitly via Money.of
    // below once the math is done, so the returned value's tag is correct.
    const usdAmount = money.times(rateFor(money.currency));
    const convertedAmount = usdAmount.dividedBy(rateFor(to));
    return Money.of(convertedAmount.toJSON().amount, to);
  }
}

export const fxService = new FxService();
