import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, TierName } from '@/types/database';
import { getActiveTierContractId } from '@/lib/tier-contracts/get-active-contract';

/**
 * Stamps the currently-active tier_contract for `tierName` onto the
 * subscriber's most recent subscriptions row for that tier. Called ONLY
 * from the "this row just became active via a real payment" branches in
 * the three billing webhooks (paystack/stripe/flutterwave) — never from a
 * cancel/past_due branch. Whatever was captured at the last real renewal
 * must persist through a lapse, per the spec's own "not just their
 * current tier" intent — re-stamping on a negative event would defeat
 * that.
 *
 * No-ops (never throws) if no active contract exists yet for `tierName` —
 * a missing seed row must never block a real payment from granting
 * access. PostgREST can't `order`/`limit` on an `update`, so this is
 * select-the-row-id-then-update-by-id, the same two-call pattern already
 * used throughout the webhook files (e.g. paystack's charge.success
 * "existing row" branch).
 */
export async function snapshotTierContractOnRenewal(
  supabase: SupabaseClient<Database>,
  userId: string,
  tierName: TierName
): Promise<void> {
  if (tierName === 'managed') return; // Managed Accounts snapshot separately — see getActiveTierContractIdForManaged

  const contractId = await getActiveTierContractId(supabase, tierName);
  if (!contractId) return;

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('tier', tierName)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!subscription) return;

  await supabase.from('subscriptions').update({ tier_contract_id: contractId }).eq('id', subscription.id);
}

/** Thin wrapper for POST /api/managed-accounts/:id/fund — see that route. */
export async function getActiveTierContractIdForManaged(supabase: SupabaseClient<Database>): Promise<string | null> {
  return getActiveTierContractId(supabase, 'managed');
}
