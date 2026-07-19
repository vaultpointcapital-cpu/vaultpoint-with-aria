import { z } from 'zod';
import type { ManagedTier, SubscriptionTier, WithdrawalWindowCadence } from '@/types/database';

/**
 * Which subscription tier unlocks which Managed Tier. Placeholder
 * mapping — the spec's PRD Section 6 (Managed Tier eligibility rules)
 * was not available when this was written. Flagged as an assumption,
 * same treatment as ALERT_LIMITS_BY_TIER's numbers in
 * validations/alerts.ts.
 */
export const MANAGED_TIER_MIN_SUBSCRIPTION: Record<ManagedTier, SubscriptionTier> = {
  bronze: 'pro',
  silver: 'pro',
  gold: 'elite',
};

const SUBSCRIPTION_TIER_RANK: Record<SubscriptionTier, number> = { free: 0, pro: 1, elite: 2 };

export function isEligibleForManagedTier(subscriptionTier: SubscriptionTier, managedTier: ManagedTier): boolean {
  return SUBSCRIPTION_TIER_RANK[subscriptionTier] >= SUBSCRIPTION_TIER_RANK[MANAGED_TIER_MIN_SUBSCRIPTION[managedTier]];
}

/**
 * Profit split / drawdown policy / withdrawal cadence per Managed Tier —
 * business terms, so these are server-defined constants a client can
 * never submit their own value for, not form input. Placeholder numbers
 * for the same reason as MANAGED_TIER_MIN_SUBSCRIPTION above.
 */
export const MANAGED_TIER_TERMS: Record<
  ManagedTier,
  { profitSplitPct: number; maxDrawdownPct: number; withdrawalWindowCadence: WithdrawalWindowCadence }
> = {
  bronze: { profitSplitPct: 30, maxDrawdownPct: 10, withdrawalWindowCadence: 'monthly' },
  silver: { profitSplitPct: 25, maxDrawdownPct: 15, withdrawalWindowCadence: 'biweekly' },
  gold: { profitSplitPct: 20, maxDrawdownPct: 20, withdrawalWindowCadence: 'on_demand' },
};

export const DISCLOSURE_DOCUMENT_VERSION = 'v1';
export const AUTHORIZATION_DOCUMENT_VERSION = 'v1';

export const disclosureViewSchema = z.object({
  documentVersion: z.string().trim().min(1),
});
export type DisclosureViewInput = z.infer<typeof disclosureViewSchema>;

/**
 * consent must be the literal boolean true. typedLegalName is the
 * "signature" itself — see client_authorizations.signature_method's
 * comment in the migration for why this is explicitly NOT treated as
 * equivalent to a real e-signature vendor's legal guarantees.
 */
export const authorizationSchema = z.object({
  documentVersion: z.string().trim().min(1),
  documentUrl: z.string().url(),
  typedLegalName: z.string().trim().min(2, 'Enter your full legal name'),
  consent: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge and sign the trading authorization' }),
  }),
});
export type AuthorizationInput = z.infer<typeof authorizationSchema>;

/**
 * Sub-account provisioning is restricted to MetaTrader only — Bybit
 * sub-account creation requires a Broker/Institutional API relationship
 * this codebase has no credentials or client code for (unlike
 * MetaTraderClient.provision(), which genuinely creates a new
 * MetaApi-backed trading account today, already built and tested for
 * regular broker_connections). A Bybit option is deliberately not
 * offered here rather than silently pretending it works.
 */
export const provisionManagedAccountSchema = z.object({
  tier: z.enum(['bronze', 'silver', 'gold'], {
    errorMap: () => ({ message: 'Select a Managed Tier' }),
  }),
  mtLogin: z.string().trim().min(1, 'MT account login is required'),
  mtServer: z.string().trim().min(1, 'MT server name is required'),
  mtPlatform: z.enum(['mt4', 'mt5'], { errorMap: () => ({ message: 'Select MT4 or MT5' }) }),
  mtPassword: z.string().trim().min(1, 'MT account password is required'),
});
export type ProvisionManagedAccountInput = z.infer<typeof provisionManagedAccountSchema>;

export const fundManagedAccountSchema = z.object({
  startingCapital: z.coerce.number().positive('Starting capital must be greater than 0'),
});
export type FundManagedAccountInput = z.infer<typeof fundManagedAccountSchema>;

export interface ManagedAccountStats {
  currentBalance: number;
  allTimePnl: number;
  pnlSinceLastDistribution: number;
  peakBalance: number;
  drawdownPct: number;
}

/**
 * Computes balance/P&L/drawdown from a chronological trade history —
 * no separate running-balance or peak-balance snapshot table exists for
 * managed_accounts (unlike portfolio_snapshots for the regular
 * aggregator), so this walks trades in closed_at order and tracks the
 * running balance and its high-water mark directly. Correct as long as
 * `trades` is every closed trade for this account and `startingCapital`
 * is the account's actual funded amount — both true of what
 * GET /api/managed-accounts/:id passes in.
 *
 * drawdownPct is peak-to-current, matching the "Drawdown-to-date vs.
 * stated max drawdown policy" dashboard requirement — not peak-to-lowest
 * (that would show a stale number once the account has recovered).
 */
export function computeAccountStats(
  startingCapital: number,
  trades: { realized_pnl: number | null; closed_at: string | null }[],
  lastDistributionPeriodEnd: string | null
): ManagedAccountStats {
  const closedTrades = trades
    .filter((t): t is { realized_pnl: number; closed_at: string } => t.realized_pnl !== null && t.closed_at !== null)
    .sort((a, b) => a.closed_at.localeCompare(b.closed_at));

  let runningBalance = startingCapital;
  let peakBalance = startingCapital;
  let pnlSinceLastDistribution = 0;

  for (const trade of closedTrades) {
    runningBalance += trade.realized_pnl;
    if (runningBalance > peakBalance) peakBalance = runningBalance;
    if (!lastDistributionPeriodEnd || trade.closed_at >= lastDistributionPeriodEnd) {
      pnlSinceLastDistribution += trade.realized_pnl;
    }
  }

  const allTimePnl = runningBalance - startingCapital;
  const drawdownPct = peakBalance > 0 ? Math.max(0, ((peakBalance - runningBalance) / peakBalance) * 100) : 0;

  return {
    currentBalance: runningBalance,
    allTimePnl,
    pnlSinceLastDistribution,
    peakBalance,
    drawdownPct,
  };
}
