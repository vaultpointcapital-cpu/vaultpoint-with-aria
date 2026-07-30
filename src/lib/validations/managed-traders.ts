import { z } from 'zod';
import type { ManagedTraderStatus } from '@/types/database';

/**
 * Covers the full PRD questionnaire Sections B–D (Sprint 2). Section A
 * (identity/ID/sanctions) is NOT collected here — it goes through the
 * KYC module instead (see getOrCreateKycVerificationRow in the apply
 * route). trailing_90d_return / max_drawdown stay server-computed-only
 * (still null — this codebase has no historical equity-snapshot data to
 * compute them from yet); a client-submitted number here would be
 * exactly the kind of unverified self-report the manual-review gate
 * exists to prevent.
 */
export const applyAsManagedTraderSchema = z
  .object({
    proposed_profit_split: z.number().min(0).max(100),
    max_clients: z.number().int().min(1).max(1000).optional(),
    strategy_description: z.string().trim().min(1, 'Describe your trading strategy').max(1000),
    has_managed_funds_before: z.boolean(),
    has_managed_funds_before_explanation: z.string().trim().max(1000).optional(),
    // Section C.13 / D.16 / D.17 — all "must check" hard gates, not
    // optional preferences. A false or missing value fails validation
    // rather than silently being recorded as "not yet confirmed."
    academy_modules_confirmed: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm completion of the required Academy modules.' }),
    }),
    understands_trade_only: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm you understand the trade-only permission scope.' }),
    }),
    agrees_to_audit_logging: z.literal(true, {
      errorMap: () => ({ message: 'You must agree to audit logging of trades and payouts.' }),
    }),
  })
  .refine((data) => !data.has_managed_funds_before || !!data.has_managed_funds_before_explanation, {
    message: 'Please describe your prior fund-management experience.',
    path: ['has_managed_funds_before_explanation'],
  });

export type ApplyAsManagedTraderInput = z.infer<typeof applyAsManagedTraderSchema>;

const REVIEW_STATUSES: readonly ManagedTraderStatus[] = ['approved', 'rejected'];

/**
 * Admin review can only move a pending application to approved/rejected
 * — not to 'suspended' (that's a separate, later lifecycle action on an
 * already-approved trader, not a review outcome) and not back to
 * 'pending' (PRD §5.1's "no partial approvals" gate rule).
 */
export const reviewManagedTraderSchema = z
  .object({
    status: z.enum(REVIEW_STATUSES as [ManagedTraderStatus, ...ManagedTraderStatus[]]),
    approved_profit_split: z.number().min(0).max(100).optional(),
    max_clients: z.number().int().min(1).max(1000).optional(),
    reviewer_notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => data.status !== 'approved' || data.approved_profit_split !== undefined, {
    message: 'approved_profit_split is required when approving a trader.',
    path: ['approved_profit_split'],
  });

export type ReviewManagedTraderInput = z.infer<typeof reviewManagedTraderSchema>;
