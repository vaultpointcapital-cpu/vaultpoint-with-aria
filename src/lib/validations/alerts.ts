import { z } from 'zod';
import type { SubscriptionTier } from '@/types/database';

/**
 * symbol is required for a 'price' alert (it targets one instrument) and
 * must be null for the three portfolio-level condition types — enforced
 * via .refine() rather than a discriminated union so each error attaches
 * to the symbol field specifically, matching the pattern already used in
 * validations/broker.ts for KuCoin/MetaTrader's conditional fields.
 */
export const createAlertSchema = z
  .object({
    symbol: z.string().trim().toUpperCase().max(20, 'Symbol is too long').nullable(),
    conditionType: z.enum(['price', 'pnl_pct', 'pnl_abs', 'margin_pct'], {
      errorMap: () => ({ message: 'Select what this alert should watch' }),
    }),
    operator: z.enum(['above', 'below'], {
      errorMap: () => ({ message: 'Select above or below' }),
    }),
    threshold: z.coerce.number().positive('Threshold must be greater than 0'),
  })
  .refine((data) => data.conditionType !== 'price' || !!data.symbol, {
    message: 'A symbol is required for a price alert',
    path: ['symbol'],
  })
  .refine((data) => data.conditionType === 'price' || data.symbol === null, {
    message: 'Portfolio-wide alerts cannot target a specific symbol',
    path: ['symbol'],
  });

export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const updateAlertSchema = z.object({
  isActive: z.boolean().optional(),
  threshold: z.coerce.number().positive('Threshold must be greater than 0').optional(),
});

export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

/**
 * Tier limits for alerts. Not specified anywhere in this repo (no PRD
 * checked in — see README's "separate PRDs" note), so this follows the
 * spec's own explicit fallback: Free capped at 3 ACTIVE alerts (disabled
 * ones don't count against the limit — only what's actually watching),
 * Pro/Elite unlimited. Flagged as an assumption, not silently picked.
 */
export const ALERT_LIMITS_BY_TIER: Record<SubscriptionTier, number> = {
  free: 3,
  pro: Infinity,
  elite: Infinity,
};

export function canCreateAnotherAlert(tier: SubscriptionTier, currentActiveAlertCount: number): boolean {
  return currentActiveAlertCount < ALERT_LIMITS_BY_TIER[tier];
}

/**
 * Plain-English description shown in the alerts list, e.g. "Alert when
 * BTCUSDT crosses above $100,000" or "Alert when margin utilization
 * crosses below 20%". Centralized here (not duplicated per component)
 * since the same phrasing is used in the active list and could be reused
 * anywhere else an alert needs to render as text.
 */
export function describeAlert(alert: {
  symbol: string | null;
  condition_type: string;
  operator: string;
  threshold: number;
}): string {
  const direction = alert.operator === 'above' ? 'crosses above' : 'crosses below';

  switch (alert.condition_type) {
    case 'price':
      return `Alert when ${alert.symbol} ${direction} $${alert.threshold.toLocaleString()}`;
    case 'pnl_pct':
      return `Alert when portfolio P&L ${direction} ${alert.threshold}%`;
    case 'pnl_abs':
      return `Alert when portfolio P&L ${direction} $${alert.threshold.toLocaleString()}`;
    case 'margin_pct':
      return `Alert when margin utilization ${direction} ${alert.threshold}%`;
    default:
      return `Alert when ${alert.condition_type} ${direction} ${alert.threshold}`;
  }
}
