/**
 * Constants and types shared between profit-share.ts (server-only —
 * imports createServiceClient/createClient, which pull in next/headers)
 * and client components that display profit-share data
 * (profit-share-statement.tsx, profit-share-dashboard.tsx). Importing
 * PROFIT_SHARE_PCT or AttributedTrade directly from profit-share.ts in
 * a 'use client' file drags next/headers into the client bundle and
 * fails the build — this file has zero server-only imports so it's
 * safe on both sides.
 */

/**
 * Percent of Aria-attributed profit charged as the monthly true-up for
 * Managed Mode (Elite subscribers autonomously traded on their OWN
 * connected broker — distinct from Managed Accounts' custodial
 * profit_distributions, where VaultPoint holds the funds directly).
 * Finalized at 20% — mid-point of MANAGED_TIER_TERMS' bronze/silver/gold
 * split range (30/25/20) in src/lib/validations/managed-accounts.ts,
 * since Managed Mode sits alongside Managed Accounts as a lighter-touch,
 * self-custody alternative and shouldn't cost more than the most
 * favorable Managed Accounts tier.
 */
export const PROFIT_SHARE_PCT = 20;

export interface AttributedTrade {
  signalId: string;
  pair: string;
  direction: 'long' | 'short';
  executedSize: number;
  realizedPnl: number;
  result: 'win' | 'loss' | 'breakeven';
  closedAt: string;
}
