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
 * Percent of Aria-attributed profit charged as the monthly true-up.
 * Not specified anywhere in the spec text available to this build —
 * flagged as an assumption the same way ALERT_LIMITS_BY_TIER's numbers
 * are in src/lib/validations/alerts.ts, not silently picked as final.
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
