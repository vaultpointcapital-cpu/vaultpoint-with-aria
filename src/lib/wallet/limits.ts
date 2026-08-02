/**
 * Placeholder per-transaction wallet limits (PRD open question #3 — no real
 * figures given yet). Single source of truth so real min/max/caps can
 * replace these without touching any route logic. No rolling daily/monthly
 * cap yet — add one here, not in a route, when real figures land.
 */
export const WALLET_LIMITS: Record<string, { min: number; max: number }> = {
  NGN: { min: 100, max: 5_000_000 },
  USD: { min: 1, max: 2_000 },
  USDT: { min: 5, max: 2_000 },
};

export function checkWalletLimit(currency: string, amount: number): { ok: true } | { ok: false; message: string } {
  const limit = WALLET_LIMITS[currency];
  if (!limit) {
    return { ok: false, message: `Unsupported wallet currency: ${currency}` };
  }
  if (amount < limit.min) {
    return { ok: false, message: `Minimum amount for ${currency} is ${limit.min}` };
  }
  if (amount > limit.max) {
    return { ok: false, message: `Maximum amount for ${currency} is ${limit.max}` };
  }
  return { ok: true };
}
