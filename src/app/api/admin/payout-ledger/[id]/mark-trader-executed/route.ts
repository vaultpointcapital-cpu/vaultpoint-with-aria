import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/payout-ledger/:id/mark-trader-executed
 *
 * The two-step crypto flow's midpoint: the trader has told VaultPoint
 * they've sent both legs of their Hantec withdrawal per the pre-filled
 * instructions (spec section 4, "app-guided two-step withdrawal
 * instruction... mark the payout as 'pending trader execution' until
 * both legs are confirmed on-chain"). Records trader_marked_executed_at
 * as a CLAIM, not proof — status stays 'pending_trader_execution'.
 * Only POST .../confirm-collected moves it to 'collected', once VaultPoint's
 * leg is independently verified, since no wallet-monitoring capability
 * exists in this codebase to confirm the trader's claim automatically
 * (src/lib/wallet/web3-adapter.ts documents that gap explicitly).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();

  const { data: entry } = await admin
    .from('payout_ledger')
    .select('id, status, collection_method')
    .eq('id', params.id)
    .maybeSingle();
  if (!entry) return apiError('NOT_FOUND', 'Payout ledger entry not found.');
  if (entry.collection_method !== 'crypto_two_step') {
    return apiError('VALIDATION_ERROR', 'This action only applies to crypto two-step payouts.');
  }
  if (entry.status !== 'pending_trader_execution') {
    return apiError('VALIDATION_ERROR', `Cannot mark trader-executed for status "${entry.status}".`);
  }

  const { data: updated, error } = await admin
    .from('payout_ledger')
    .update({ trader_marked_executed_at: new Date().toISOString() })
    .eq('id', entry.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not record trader execution.');

  return apiSuccess({ entry: updated });
}
