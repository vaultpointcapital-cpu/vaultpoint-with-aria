import { z } from 'zod';
import { TIER_LIMITS } from '@/lib/billing/tier-limits';
import type { SubscriptionTier } from '@/types/database';

export const createPodSchema = z.object({
  name: z.string().trim().min(1, 'Give your pod a name').max(60, 'Name is too long'),
  targetAmount: z.coerce
    .number()
    .positive('Target must be greater than 0')
    .max(100_000_000, 'Target amount is unreasonably large'),
  currency: z.string().trim().length(3, 'Use a 3-letter currency code, e.g. USD').default('USD'),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex code')
    .default('#6C63FF'),
  deadline: z.string().date().optional().nullable(),
});

export type CreatePodInput = z.infer<typeof createPodSchema>;

export const contributeToPodSchema = z.object({
  amount: z.coerce.number().positive('Contribution must be greater than 0'),
  note: z.string().trim().max(200, 'Note is too long').optional(),
});

export type ContributeToPodInput = z.infer<typeof contributeToPodSchema>;

/**
 * Free = 1 pod, Pro = 10, Elite = unlimited. Sourced from
 * lib/billing/tier-limits.ts's TIER_LIMITS — the single source of truth
 * across every tier-gated feature, not just Pods. Re-exported under this
 * name so the API route and UI "add pod" disabled-state check don't need
 * to change.
 */
export const POD_LIMITS_BY_TIER: Record<SubscriptionTier, number> = {
  free: TIER_LIMITS.free.maxPods,
  pro: TIER_LIMITS.pro.maxPods,
  elite: TIER_LIMITS.elite.maxPods,
};

export function canCreateAnotherPod(tier: SubscriptionTier, currentPodCount: number): boolean {
  return currentPodCount < POD_LIMITS_BY_TIER[tier];
}
