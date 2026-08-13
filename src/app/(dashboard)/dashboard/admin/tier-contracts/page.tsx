import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { TierContractsAdmin } from '@/components/admin/tier-contracts-admin';
import type { TierContract, TierCommitment, TierName } from '@/types/database';

const ALL_TIERS: TierName[] = ['free', 'pro', 'elite', 'managed'];

export interface TierContractWithCommitments extends TierContract {
  commitments: TierCommitment[];
}

export default async function TierContractsAdminPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();

  const [activeResult, historyResult] = await Promise.all([
    admin.from('tier_contracts').select('*').eq('status', 'active'),
    admin
      .from('tier_contracts')
      .select('*')
      .eq('status', 'superseded')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const allContracts = [...(activeResult.data ?? []), ...(historyResult.data ?? [])];
  const { data: commitments } = allContracts.length
    ? await admin
        .from('tier_commitments')
        .select('*')
        .in(
          'tier_contract_id',
          allContracts.map((c) => c.id)
        )
    : { data: [] };

  const commitmentsByContract = new Map<string, TierCommitment[]>();
  for (const commitment of commitments ?? []) {
    const existing = commitmentsByContract.get(commitment.tier_contract_id);
    if (existing) {
      existing.push(commitment);
    } else {
      commitmentsByContract.set(commitment.tier_contract_id, [commitment]);
    }
  }

  const withCommitments = (contracts: TierContract[]): TierContractWithCommitments[] =>
    contracts.map((c) => ({ ...c, commitments: commitmentsByContract.get(c.id) ?? [] }));

  // One slot per tier_name, even if a tier has no active contract yet
  // (shouldn't happen post-seed, but the admin view shouldn't crash if it
  // does) — ALL_TIERS drives the layout, not whatever rows happen to exist.
  const active = ALL_TIERS.map(
    (tierName) => withCommitments(activeResult.data ?? [])?.find((c) => c.tier_name === tierName) ?? null
  );

  return (
    <TierContractsAdmin active={active} history={withCommitments(historyResult.data ?? [])} tiers={ALL_TIERS} />
  );
}
