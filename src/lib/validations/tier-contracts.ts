import { z } from 'zod';
import type { CommitmentType, TierName } from '@/types/database';

const TIER_NAMES: readonly TierName[] = ['free', 'pro', 'elite', 'managed'];
const COMMITMENT_TYPES: readonly CommitmentType[] = ['feature_access', 'outcome', 'sla', 'limit'];

/**
 * The `.refine()` below is the practical stand-in for the Tier Contract
 * spec's "reject at data-entry time if the metric doesn't exist" ask —
 * there's no real Value Ledger metric catalog to validate existence
 * against (see 20260815000002_add_tier_contracts.sql's header comment),
 * so this enforces the one piece that IS checkable: a measurable
 * commitment must at least carry non-empty metric_key text. The DB's own
 * CHECK constraint (tier_commitments_measurable_requires_metric_key)
 * enforces the same rule as a second, DB-level backstop.
 */
const tierCommitmentInputSchema = z
  .object({
    commitmentKey: z.string().trim().min(1, 'commitment_key is required'),
    commitmentDescription: z.string().trim().min(1, 'commitment_description is required'),
    commitmentType: z.enum(COMMITMENT_TYPES as [CommitmentType, ...CommitmentType[]]),
    measurable: z.boolean(),
    metricKey: z.string().trim().min(1).nullable(),
  })
  .refine((c) => !c.measurable || c.metricKey !== null, {
    message: 'A measurable commitment must include a metric_key.',
    path: ['metricKey'],
  });

export const createTierContractVersionSchema = z.object({
  tierName: z.enum(TIER_NAMES as [TierName, ...TierName[]]),
  priceNgn: z.number().int().nonnegative().nullable(),
  priceUsd: z.number().int().nonnegative().nullable(),
  effectiveDate: z.string().trim().min(1, 'effective_date is required'),
  // change_reason is required per the spec's own non-negotiable #1
  // ("never edit an active row in place — always version, with a
  // reason") — enforced here AND by create_tier_contract_version() at
  // the DB level, same two-layer belt-and-braces as the metric_key rule
  // above.
  changeReason: z.string().trim().min(1, 'change_reason is required'),
  commitments: z.array(tierCommitmentInputSchema).min(1, 'At least one commitment is required'),
});

export type CreateTierContractVersionRequest = z.infer<typeof createTierContractVersionSchema>;
