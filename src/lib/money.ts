import Decimal from 'decimal.js';

/**
 * Money & Currency Layer — the only place money arithmetic is allowed to
 * live in this codebase. Never use raw `number` for a currency amount
 * (D2): JS `number` is IEEE-754 — 0.1 + 0.2 !== 0.3, and that error
 * compounds across thousands of positions into a net worth figure that's
 * wrong in the last decimals and non-deterministic between recomputations.
 *
 * Enforcement: Money deliberately implements no valueOf()/Symbol.toPrimitive,
 * so `moneyA + moneyB` is a `tsc` compile error today — no ESLint rule
 * needed (a real no-restricted-syntax ban on Money-typed operands would
 * need type-aware linting, which this repo's legacy .eslintrc.json/
 * next/core-web-vitals setup doesn't have; the compiler already does the
 * job, and fails the build, not just lint).
 */

// 28 significant digits, more than enough headroom over our 20,8 storage.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface MoneyJSON {
  readonly amount: string;
  readonly currency: string;
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: CurrencyCode
  ) {}

  static of(amount: string | number | Decimal, currency: string): Money {
    if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
      // Guard against float-derived amounts sneaking in from JSON or bad
      // callers — pass a string instead (e.g. Money.of(String(row.value), row.currency)).
      throw new Error(`Money.of received a non-integer number (${amount}). Pass a string instead.`);
    }
    return new Money(new Decimal(amount), currency as CurrencyCode);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency as CurrencyCode);
  }

  private assertSame(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}. Convert first.`);
    }
  }

  plus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  minus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  times(factor: string | number | Decimal): Money {
    return new Money(this.value.times(new Decimal(factor)), this.currency);
  }

  /** Money / scalar = Money (e.g. converting a USD amount by dividing by
   * a target currency's rate_to_usd — src/lib/fx.ts's convert/convertAt).
   * Not to be confused with ratioTo, which is Money / Money = a
   * dimensionless ratio. */
  dividedBy(divisor: string | number | Decimal): Money {
    return new Money(this.value.dividedBy(new Decimal(divisor)), this.currency);
  }

  /**
   * Money / Money = a dimensionless ratio, not Money — every percentage
   * calculation in src/lib/utils/financial.ts (P&L %, day change %,
   * allocation %, pod progress %, margin utilization %) needs this, not a
   * scalar-division method. Multiply the result by 100 and round only at
   * the display edge (D8) — never inside this class.
   */
  ratioTo(other: Money): Decimal {
    this.assertSame(other);
    if (other.value.isZero()) {
      throw new Error('Cannot compute a ratio against a zero amount — guard for this before calling ratioTo.');
    }
    return this.value.dividedBy(other.value);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  /** Full precision — for storage and further calculation. Never for display. */
  toJSON(): MoneyJSON {
    return { amount: this.value.toFixed(8), currency: this.currency };
  }

  /** Rounded — display edge only. */
  format(locale = 'en-NG'): string {
    const dp = ZERO_DECIMAL.has(this.currency) ? 0 : 2;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(this.value.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toNumber());
  }
}

/**
 * Parses a MoneyJSON payload (e.g. from an API response or a stored
 * fx_rates-adjacent value) back into a Money instance. The inverse of
 * Money.toJSON() — round-trips all 8 decimal places.
 */
export function moneyFromJSON(json: MoneyJSON): Money {
  return Money.of(json.amount, json.currency);
}
