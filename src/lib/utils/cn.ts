import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges Tailwind classes safely, resolving conflicts (e.g. a later
 * `px-4` overriding an earlier `px-2`) rather than just concatenating
 * strings. Standard shadcn/ui pattern.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats a number as USD currency, e.g. 84320 -> "$84,320.00".
 */
export function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Formats a percentage with a leading sign, e.g. 2.23 -> "+2.23%", -1.5 -> "-1.50%".
 */
export function formatPercentage(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

const MONEY_ZERO_DECIMAL = new Set(['JPY', 'KRW']);

/**
 * Money & Currency Layer — the client-side counterpart to
 * src/lib/money.ts's Money.format(). Deliberately dependency-free (no
 * decimal.js import) per the spec's own client-bundle-size risk
 * mitigation: Money/decimal.js only ever runs server-side; a 'use client'
 * component receives an already-computed { amount, currency } (a
 * MoneyJSON, from src/lib/money.ts) and renders it with this instead.
 * Display-only rounding via Number() is safe here — the arithmetic that
 * needed 8dp precision already happened server-side before this ever runs.
 */
export function formatMoneyJSON(money: { amount: string; currency: string }, locale = 'en-NG'): string {
  const dp = MONEY_ZERO_DECIMAL.has(money.currency) ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(Number(money.amount));
}

/**
 * Progress toward a Savings Pod's target, clamped to [0, 100] — the exact
 * formula src/lib/utils/financial.ts's calculatePodProgress() uses, but
 * plain-number rather than Money. Deliberately NOT routed through Money
 * here: this is always a single pod's own current/target pair (same
 * currency by construction — there's no cross-currency mixing risk
 * calculatePodProgress's Money inputs guard against), and pod-card.tsx/
 * pod-detail-dialog.tsx need this to stay client-reactive (recomputed
 * instantly after a contribution succeeds, no server round-trip) —
 * financial.ts can't be imported into a 'use client' file (decimal.js
 * bundle size). calculatePodProgress itself is still the canonical
 * server-side version, used wherever pods are aggregated across a list
 * server-side (e.g. dashboard/page.tsx).
 */
export function calculateProgressPct(currentAmount: number, targetAmount: number): number {
  if (targetAmount <= 0) return 0;
  const pct = (currentAmount / targetAmount) * 100;
  return Math.min(100, Math.max(0, pct));
}
