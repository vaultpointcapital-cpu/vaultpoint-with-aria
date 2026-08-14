import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * GET /api/admin/step-up/audit-log?user_id=&action_type=&from=&to=&limit=&offset=
 *
 * Step-Up Auth Ticket 5. Path adapted from the spec's bare
 * /auth/audit-log to this codebase's admin routing convention (every
 * other admin-only endpoint lives under /api/admin/, e.g.
 * /api/admin/managed-accounts) — same "no bare /auth/* route space"
 * adaptation every prior ticket in this sprint made.
 *
 * step_up_audit_log already has its own RLS (users can read their own
 * rows — see 20260726000002_add_step_up_approvals.sql); this route is
 * the cross-user admin view on top of it, same is_admin-then-service-
 * client pattern as every other admin route (see src/lib/auth/admin.ts
 * and e.g. GET /api/admin/managed-accounts). Pagination matches
 * GET /api/alerts/history's own limit/offset convention.
 *
 * No admin UI page reads this yet — every ticket in this sprint has
 * been backend-only (no step-up frontend exists at all), consistent
 * with that.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('user_id');
  const actionType = searchParams.get('action_type');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  const from = fromParam ? new Date(fromParam) : null;
  const to = toParam ? new Date(toParam) : null;
  if ((fromParam && Number.isNaN(from!.getTime())) || (toParam && Number.isNaN(to!.getTime()))) {
    return apiError('VALIDATION_ERROR', '"from" and "to" must be valid ISO 8601 dates.');
  }

  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(searchParams.get('limit')) || DEFAULT_PAGE_SIZE));
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0);

  const admin = createServiceClient();
  let query = admin
    .from('step_up_audit_log')
    .select('id, approval_id, user_id, action_type, resource_id, status, method, created_at', { count: 'exact' });

  if (userId) query = query.eq('user_id', userId);
  if (actionType) query = query.eq('action_type', actionType);
  if (from) query = query.gte('created_at', from.toISOString());
  if (to) query = query.lte('created_at', to.toISOString());

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load the step-up audit log.');
  }

  return apiSuccess({
    entries: data,
    pagination: { limit, offset, total: count ?? 0, hasMore: offset + limit < (count ?? 0) },
  });
}
