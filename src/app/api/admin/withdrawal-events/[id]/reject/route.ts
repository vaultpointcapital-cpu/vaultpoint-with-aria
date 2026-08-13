import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { rejectWithdrawalEventSchema } from '@/lib/validations/payouts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/withdrawal-events/:id/reject
 *
 * Marks a detection as a false positive (e.g. a data glitch, a
 * MetaApi hiccup) — no payout_ledger row is ever created for a rejected
 * event, since calculate_payout_split() is only ever called from the
 * confirm route or automatically for auto_detected events.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = rejectWithdrawalEventSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'A reason is required.', parsed.error.flatten());

  const admin = createServiceClient();

  const { data: event } = await admin.from('withdrawal_events').select('id, status').eq('id', params.id).maybeSingle();
  if (!event) return apiError('NOT_FOUND', 'Withdrawal event not found.');
  if (event.status !== 'pending') {
    return apiError('VALIDATION_ERROR', `Cannot reject a withdrawal event with status "${event.status}".`);
  }

  const { data: updated, error } = await admin
    .from('withdrawal_events')
    .update({ status: 'rejected' })
    .eq('id', event.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not reject this withdrawal event.');

  return apiSuccess({ event: updated });
}
