import { createClient } from '@/lib/supabase/server';
import { computeTrackRecord } from '@/lib/validations/signals';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/signals/track-record
 * Win rate / avg R-multiple across the caller's closed signal actions.
 *
 * signal_outcomes has no user_id column of its own — RLS scopes it via a
 * join through signal_actions.user_id (see
 * supabase/migrations/20260718000000_add_signal_mode.sql), so unlike
 * every other route in this app there's no extra .eq('user_id', ...) to
 * layer on as defense in depth here; the join-based policy is the only
 * enforcement, by design of the schema.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase.from('signal_outcomes').select('result, realized_r_multiple');

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load your track record.');
  }

  return apiSuccess(computeTrackRecord(data ?? []));
}
