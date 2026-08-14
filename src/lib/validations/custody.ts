import { z } from 'zod';

export const updateCustodySettingsSchema = z.object({
  withdrawalReviewHoldThresholdUsd: z.coerce.number().nonnegative().nullable().optional(),
});

export const rejectCustodyTransactionSchema = z.object({
  reason: z.string().min(1, 'A reason is required to reject a withdrawal.'),
});
