import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, TierCommitment, TierContract, TierName } from '@/types/database';

/**
 * The one shared lookup every other tier-contracts helper (snapshot.ts,
 * admin.ts, the pricing page) reads through — at most one 'active' row per
 * tier_name exists (enforced by tier_contracts_one_active_per_tier, see
 * supabase/migrations/20260815000002_add_tier_contracts.sql), so this is
 * always a single-row lookup, never a list.
 */
export async function getActiveTierContractId(
  supabase: SupabaseClient<Database>,
  tierName: TierName
): Promise<string | null> {
  const { data } = await supabase
    .from('tier_contracts')
    .select('id')
    .eq('tier_name', tierName)
    .eq('status', 'active')
    .maybeSingle();

  return data?.id ?? null;
}

export async function getActiveTierContract(
  supabase: SupabaseClient<Database>,
  tierName: TierName
): Promise<(TierContract & { commitments: TierCommitment[] }) | null> {
  const { data: contract } = await supabase
    .from('tier_contracts')
    .select('*')
    .eq('tier_name', tierName)
    .eq('status', 'active')
    .maybeSingle();

  if (!contract) return null;

  const { data: commitments } = await supabase
    .from('tier_commitments')
    .select('*')
    .eq('tier_contract_id', contract.id)
    .order('created_at', { ascending: true });

  return { ...contract, commitments: commitments ?? [] };
}
