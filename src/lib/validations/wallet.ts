import { z } from 'zod';

export const depositInitiateSchema = z.object({
  amount: z.coerce.number().positive('Deposit amount must be greater than 0'),
  currency: z.enum(['NGN', 'USD', 'USDT']),
  provider: z.enum(['paystack', 'stripe', 'crypto']).optional(),
});

export type DepositInitiateInput = z.infer<typeof depositInitiateSchema>;

export const withdrawRequestSchema = z.object({
  amount: z.coerce.number().positive('Withdrawal amount must be greater than 0'),
  currency: z.enum(['NGN', 'USD', 'USDT']),
  destinationType: z.enum(['bank_account', 'mobile_money', 'crypto_address']),
  destinationDetails: z.record(z.string(), z.string()).refine((obj) => Object.keys(obj).length > 0, {
    message: 'Destination details are required',
  }),
});

export type WithdrawRequestInput = z.infer<typeof withdrawRequestSchema>;

export const withdrawConfirmSchema = z.object({
  withdrawalRequestId: z.string().uuid(),
  stepUpApprovalId: z.string().trim().min(1, 'A confirmed step-up approval is required'),
});

export type WithdrawConfirmInput = z.infer<typeof withdrawConfirmSchema>;
