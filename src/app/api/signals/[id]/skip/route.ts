import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/signals/:id/skip
 * Records that the user chose not to act on a signal. Unlike execute,
 * this never touches the Python service or a broker — it's a plain
 * insert, and RLS on signal_actions already permits it for a
 * user-scoped client (auth.uid() = user_id, see
 * supabase/migrations/20260718000000_add_signal_mode.sql).
 *
 * signal_actions_one_terminal_action_per_user_per_signal (see
 * 20260718000001_add_failed_signal_action.sql) rejects a second
 * executed/skipped/ignored row for the same (signal_id, user_id) — that
 * unique violation is the expected way of finding out the user already
 * acted on this signal from another tab/device.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('signal_actions')
    .insert({
      signal_id: params.id,
      user_id: authData.user.id,
      broker_connection_id: null,
      action: 'skipped',
      executed_size: null,
      broker_order_id: null,
      failure_reason: null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return apiError('VALIDATION_ERROR', 'You already acted on this signal.');
    }
    return apiError('INTERNAL_ERROR', 'Could not record your response to this signal.');
  }

  return apiSuccess({ action: data }, 201);
}
