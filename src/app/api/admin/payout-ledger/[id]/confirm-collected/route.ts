import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/payout-ledger/:id/confirm-collected
 *
 * The one place a payout_ledger row moves to 'collected' — after that,
 * the DB-level trigger (prevent_collected_payout_ledger_edit) makes the
 * row immutable, per spec section 3.5. For crypto_two_step this is a
 * manual "I checked the block explorer, VaultPoint's leg arrived"
 * confirmation (no wallet-monitoring capability exists to automate it);
 * for fiat_card_charge this follows a successful POST .../charge-fiat.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();

  const { data: entry } = await admin.from('payout_ledger').select('id, status').eq('id', params.id).maybeSingle();
  if (!entry) return apiError('NOT_FOUND', 'Payout ledger entry not found.');
  if (entry.status === 'collected') {
    return apiError('VALIDATION_ERROR', 'This payout is already collected and immutable.');
  }
  if (entry.status !== 'pending' && entry.status !== 'pending_trader_execution') {
    return apiError('VALIDATION_ERROR', `Cannot confirm collection for status "${entry.status}".`);
  }

  const { data: updated, error } = await admin
    .from('payout_ledger')
    .update({ status: 'collected', collected_at: new Date().toISOString() })
    .eq('id', entry.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not confirm collection for this payout.');

  return apiSuccess({ entry: updated });
}
