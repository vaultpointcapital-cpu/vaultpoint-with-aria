import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/alerts/history
 * Lists the user's fired-alert history, most recent first. Read-only —
 * alert_history is written by the (not-yet-built) Python evaluator via
 * the service-role key, never by this route or any user action. RLS only
 * grants users SELECT on their own rows (alert_history_select_own).
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('alert_history')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load alert history.');
  }

  return apiSuccess({ history: data });
}
