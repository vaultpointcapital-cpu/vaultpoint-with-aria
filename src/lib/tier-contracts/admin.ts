import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, CommitmentType } from '@/types/database';

export interface CreateTierContractVersionCommitmentInput {
  commitmentKey: string;
  commitmentDescription: string;
  commitmentType: CommitmentType;
  measurable: boolean;
  metricKey: string | null;
}

export interface CreateTierContractVersionInput {
  tierName: string;
  priceNgn: number | null;
  priceUsd: number | null;
  effectiveDate: string;
  createdBy: string;
  changeReason: string;
  commitments: CreateTierContractVersionCommitmentInput[];
}

/**
 * Thin wrapper around create_tier_contract_version() — the only
 * sanctioned write path for a new tier_contract version (see
 * supabase/migrations/20260815000002_add_tier_contracts.sql). Called from
 * POST /api/admin/tier-contracts with a service-role client, after that
 * route's own isAdmin() check — this function does no authorization
 * itself.
 */
export async function createTierContractVersion(
  supabase: SupabaseClient<Database>,
  input: CreateTierContractVersionInput
): Promise<{ tierContractId: string; version: number }> {
  const { data, error } = await supabase.rpc('create_tier_contract_version', {
    p_tier_name: input.tierName,
    p_price_ngn: input.priceNgn,
    p_price_usd: input.priceUsd,
    p_effective_date: input.effectiveDate,
    p_created_by: input.createdBy,
    p_change_reason: input.changeReason,
    p_commitments: input.commitments.map((c) => ({
      commitment_key: c.commitmentKey,
      commitment_description: c.commitmentDescription,
      commitment_type: c.commitmentType,
      measurable: c.measurable,
      metric_key: c.metricKey,
    })),
  });

  if (error) throw error;

  const row = data?.[0];
  if (!row) throw new Error('create_tier_contract_version returned no row.');
  return { tierContractId: row.tier_contract_id, version: row.version };
}
