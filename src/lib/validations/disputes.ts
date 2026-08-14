import { z } from 'zod';
import type { Dispute, DisputeCategory } from '@/types/database';

export const createDisputeSchema = z.object({
  managedAccountId: z.string().uuid().optional(),
  managedSubAccountId: z.string().uuid().optional(),
  category: z.enum(['fee', 'performance', 'recommendation', 'other']),
  escalationReason: z.string().min(1, 'Describe what you disagree with.'),
});

export const escalateDisputeSchema = z.object({
  escalationReason: z.string().min(1, 'A reason is required to escalate a dispute.'),
});

export const resolveDisputeSchema = z.object({
  status: z.enum(['resolved', 'closed']),
  resolutionSummary: z.string().min(1, 'A resolution summary is required.'),
  resolutionAmountNgn: z.coerce.number().nonnegative().optional(),
});

export const updateDisputeSettingsSchema = z.object({
  tier2SupportOwnerName: z.string().min(1).nullable().optional(),
  tier3MaxAuthorizationNgn: z.coerce.number().nonnegative().nullable().optional(),
  tier4LegalContact: z.string().min(1).nullable().optional(),
});

// Fixed SLA numbers per the spec (section 2) — Tier 1 needs no row/SLA,
// Tier 4 (external legal) has no explicit SLA given, only "24-hour
// acknowledgment, 10 business day resolution target" for Tier 3. Business-
// day math skips weekends only — no public-holiday calendar exists in this
// codebase, a documented simplification, not an oversight.
const TIER_SLA: Record<number, { ackHours: number; resolutionBusinessDays: number } | null> = {
  1: null,
  2: { ackHours: 48, resolutionBusinessDays: 5 },
  3: { ackHours: 24, resolutionBusinessDays: 10 },
  4: null,
};

function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

export interface DisputeSlaStatus {
  ackDeadline: Date | null;
  resolutionDeadline: Date | null;
  ackBreached: boolean;
  resolutionBreached: boolean;
  isBreached: boolean;
}

const TERMINAL_STATUSES = new Set(['resolved', 'closed', 'escalated']);

/**
 * Pure function, same shape as computeComplianceFlags — reused by the
 * admin list/detail views (rendering) and the SLA-breach cron
 * (app/api/disputes/cron/sla-check) so both agree on exactly what
 * "breached" means, from the same inputs, always.
 */
export function computeSlaStatus(
  dispute: Pick<Dispute, 'tier' | 'opened_at' | 'acknowledged_at' | 'resolved_at' | 'status'>
): DisputeSlaStatus {
  const config = TIER_SLA[dispute.tier];
  if (!config) {
    return { ackDeadline: null, resolutionDeadline: null, ackBreached: false, resolutionBreached: false, isBreached: false };
  }

  const openedAt = new Date(dispute.opened_at);
  const ackDeadline = new Date(openedAt.getTime() + config.ackHours * 60 * 60 * 1000);
  const resolutionDeadline = addBusinessDays(openedAt, config.resolutionBusinessDays);

  const isTerminal = TERMINAL_STATUSES.has(dispute.status);
  const now = new Date();

  const ackBreached = !dispute.acknowledged_at && !isTerminal && now > ackDeadline;
  const resolutionBreached = !dispute.resolved_at && !isTerminal && now > resolutionDeadline;

  return { ackDeadline, resolutionDeadline, ackBreached, resolutionBreached, isBreached: ackBreached || resolutionBreached };
}

/**
 * Same-day visibility rule (spec section 4): any performance-category
 * dispute on a managed account is high reputational/regulatory risk
 * regardless of formal SLA — checked at dispute-creation time, not on a
 * schedule, so "same-day" is trivially satisfied by "immediately."
 */
export function requiresImmediateAlert(category: DisputeCategory, hasLinkedAccount: boolean): boolean {
  return category === 'performance' && hasLinkedAccount;
}
