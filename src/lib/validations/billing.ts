import { z } from 'zod';

export const checkoutSchema = z.object({
  tier: z.enum(['pro', 'elite'], { errorMap: () => ({ message: 'tier must be "pro" or "elite"' }) }),
  preferred_provider: z.enum(['stripe', 'paystack']).optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Ordering used to compare "already has an active subscription at this tier or higher". */
export const TIER_RANK = { free: 0, pro: 1, elite: 2 } as const;
