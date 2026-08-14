import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/withdrawal-events/:id/confirm
 *
 * Admin sign-off that a confidence='requires_manual_confirmation' event
 * is a real withdrawal — "no auto-finalized payout without either
 * high-confidence detection or manual sign-off" (spec section 3.3). Sets
 * status='confirmed' and calls calculate_payout_split(), the same RPC
 * app/payout_detection.py calls automatically for auto_detected events.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();

  const { data: event } = await admin.from('withdrawal_events').select('*').eq('id', params.id).maybeSingle();
  if (!event) return apiError('NOT_FOUND', 'Withdrawal event not found.');
  if (event.status !== 'pending') {
    return apiError('VALIDATION_ERROR', `Cannot confirm a withdrawal event with status "${event.status}".`);
  }

  const { error: updateError } = await admin.from('withdrawal_events').update({ status: 'confirmed' }).eq('id', event.id);
  if (updateError) return apiError('INTERNAL_ERROR', 'Could not confirm this withdrawal event.');

  const { data: ledger, error: rpcError } = await admin.rpc('calculate_payout_split', {
    p_withdrawal_event_id: event.id,
  });
  if (rpcError) {
    return apiError('INTERNAL_ERROR', `Withdrawal confirmed, but the split could not be calculated: ${rpcError.message}`);
  }

  return apiSuccess({ payoutLedger: ledger });
}
