import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * GET /api/alerts/history?limit=&offset=
 * Lists the user's fired-alert history, most recent first, paginated.
 * Read-only — alert_history is written by the Python Alert Engine via
 * the service-role key, never by this route or any user action. RLS only
 * grants users SELECT on their own rows (alert_history_select_own).
 *
 * limit/offset are optional; omitting both returns the first
 * DEFAULT_PAGE_SIZE rows — no current caller in this repo depends on
 * getting every row back unpaginated (checked before adding this).
 */
export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE)
  );
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0);

  const { data, error, count } = await supabase
    .from('alert_history')
    .select('*', { count: 'exact' })
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load alert history.');
  }

  return apiSuccess({
    history: data,
    pagination: { limit, offset, total: count ?? 0, hasMore: offset + limit < (count ?? 0) },
  });
}
