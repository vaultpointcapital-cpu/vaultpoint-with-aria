import { z } from 'zod';
import type { ManagedTier, SubscriptionTier, WithdrawalWindowCadence } from '@/types/database';

/**
 * Which subscription tier unlocks which Managed Tier. Finalized against
 * the existing subscription pricing (Pro NGN 20,000/mo, Elite NGN
 * 55,000/mo — see src/lib/billing/flutterwave.ts's TIER_AMOUNT_NGN) in
 * the absence of a separate Managed Accounts PRD: Bronze/Silver sit on
 * top of Pro, Gold requires Elite, matching how every other
 * higher-trust feature in this codebase (Aria, Managed Mode) is already
 * gated to Elite only.
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
 * never submit their own value for, not form input. Finalized (no
 * separate Managed Accounts PRD exists to source these from instead):
 * each step up in Managed Tier requires the next subscription tier and
 * trades VaultPoint's own cut down for more drawdown tolerance and more
 * frequent withdrawal access, the same "pay more, get more" shape as
 * the Pro/Elite subscription split itself. Revisit if/when Legal
 * specifies different numbers — nothing about this shape is
 * SEC-mandated, it's a product decision.
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

export interface DistributionBreakdown {
  grossPnl: number;
  clientSharePct: number;
  clientShare: number;
  vaultpointShare: number;
}

/**
 * The "Gross P&L -> Your share -> VaultPoint's share -> Net to you"
 * breakdown the withdrawal flow's own acceptance criteria requires
 * showing before the client confirms. VaultPoint only ever splits
 * PROFIT, never principal or a loss — a negative or zero grossPnl
 * returns a zero split with the full (zero-or-negative) amount as the
 * client's share, never a negative vaultpointShare. Rounded to cents,
 * same reasoning as profit-share.ts's runProfitShareForUser (a real
 * payout must be a whole number of cents, even though grossPnl itself
 * is an arbitrary-precision Postgres numeric).
 */
export function computeDistributionBreakdown(grossPnl: number, profitSplitPct: number): DistributionBreakdown {
  if (grossPnl <= 0) {
    return { grossPnl, clientSharePct: 100, clientShare: grossPnl, vaultpointShare: 0 };
  }

  const vaultpointShare = Math.round(grossPnl * (profitSplitPct / 100) * 100) / 100;
  const clientShare = Math.round((grossPnl - vaultpointShare) * 100) / 100;

  return { grossPnl, clientSharePct: 100 - profitSplitPct, clientShare, vaultpointShare };
}

export interface ComplianceFlag {
  type: 'high_drawdown' | 'disclosure_reconfirmation_required' | 'kyc_backlog' | 'stale_pending_withdrawal' | 'missing_authorization';
  detail: string;
}

const KYC_BACKLOG_DAYS = 3;
const STALE_WITHDRAWAL_DAYS = 5;
export const HIGH_DRAWDOWN_WARNING_RATIO = 0.8;

/**
 * The compliance dashboard's own acceptance criteria call for
 * "drawdown/discrepancy/missing-signature alerts." missing_authorization
 * is checked here even though managed_accounts_funding_requires_authorization
 * already makes that state impossible to reach through normal application
 * writes — this is the belt-and-suspenders check the spec explicitly asks
 * for, for whatever reaches this state through a path the CHECK constraint
 * doesn't cover (a manual service-role fix, a future migration). Backlog/
 * staleness day thresholds are placeholders, same caveat as
 * MANAGED_TIER_TERMS's numbers — no PRD Section 6 SLA was available.
 */
export function computeComplianceFlags(
  account: {
    status: string;
    max_drawdown_pct: number;
    kyc_status: string;
    client_authorization_id: string | null;
    requires_disclosure_reconfirmation: boolean;
    created_at: string;
  },
  drawdownPct: number,
  pendingDistributions: { requested_at: string | null }[],
  now: Date = new Date()
): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];

  if (account.status === 'active' && drawdownPct >= account.max_drawdown_pct * HIGH_DRAWDOWN_WARNING_RATIO) {
    flags.push({
      type: 'high_drawdown',
      detail: `Drawdown ${drawdownPct.toFixed(1)}% is at or above ${(HIGH_DRAWDOWN_WARNING_RATIO * 100).toFixed(0)}% of the ${account.max_drawdown_pct}% policy maximum.`,
    });
  }

  if (account.requires_disclosure_reconfirmation) {
    flags.push({ type: 'disclosure_reconfirmation_required', detail: 'Client has not re-accepted updated tier terms.' });
  }

  if (account.kyc_status === 'pending') {
    const ageDays = (now.getTime() - new Date(account.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= KYC_BACKLOG_DAYS) {
      flags.push({ type: 'kyc_backlog', detail: `KYC has been pending for ${Math.floor(ageDays)} days.` });
    }
  }

  for (const distribution of pendingDistributions) {
    if (!distribution.requested_at) continue;
    const ageDays = (now.getTime() - new Date(distribution.requested_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= STALE_WITHDRAWAL_DAYS) {
      flags.push({
        type: 'stale_pending_withdrawal',
        detail: `A withdrawal request has been pending for ${Math.floor(ageDays)} days.`,
      });
    }
  }

  if ((account.status === 'pending_funding' || account.status === 'active') && !account.client_authorization_id) {
    flags.push({ type: 'missing_authorization', detail: 'Account has no linked signed authorization record.' });
  }

  return flags;
}

export const withdrawalRequestSchema = z.object({
  withdrawalType: z.enum(['profit', 'full_closure']),
  payoutMethod: z.string().trim().min(1, 'Select a payout method'),
  confirmUnderstanding: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you understand this withdrawal before continuing' }),
  }),
});
export type WithdrawalRequestInput = z.infer<typeof withdrawalRequestSchema>;
