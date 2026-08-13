import { z } from 'zod';

/**
 * Body for POST /api/admin/prop-payout-agreements — admin sets the
 * business terms (split percentage/direction, funding partner).
 * trader_payout_wallet_address is deliberately NOT settable here — the
 * trader sets it themselves via PUT /api/prop-payout-agreements/:id/wallet.
 * No split-math lives in this file or anywhere in TS — calculate_payout_split()
 * (the Postgres RPC) is the only place that computes a split, so there is
 * nowhere for application code and the DB layer to silently disagree.
 */
export const createPropPayoutAgreementSchema = z.object({
  brokerConnectionId: z.string().uuid(),
  userId: z.string().uuid(),
  fundingPartner: z.string().min(1).default('hantec_trader'),
  profitSplitPct: z.coerce.number().positive().max(100),
  splitDirection: z.enum(['trader_first', 'platform_first']).default('trader_first'),
});

export const updatePropPayoutAgreementSchema = z.object({
  profitSplitPct: z.coerce.number().positive().max(100).optional(),
  splitDirection: z.enum(['trader_first', 'platform_first']).optional(),
  active: z.boolean().optional(),
});

/** Body for PUT /api/prop-payout-agreements/:id/wallet — trader-set, never admin-set. */
export const updateTraderWalletSchema = z.object({
  walletAddress: z.string().min(1, 'Enter a wallet address.'),
});

export const rejectWithdrawalEventSchema = z.object({
  reason: z.string().min(1, 'A reason is required to reject a detected withdrawal.'),
});

export const updatePayoutSettingsSchema = z.object({
  vaultpointCryptoWalletAddress: z.string().min(1).nullable().optional(),
  vaultpointCryptoNetwork: z.string().min(1).nullable().optional(),
});
