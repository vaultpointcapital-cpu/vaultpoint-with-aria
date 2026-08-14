import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/admin/withdrawal-events — the review queue. A
 * confidence='requires_manual_confirmation' + status='pending' row is
 * the queue itself (spec section 3.3); this route returns everything so
 * the admin UI can filter/sort client-side, same shape as
 * /api/admin/disputes.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: events, error } = await admin
    .from('withdrawal_events')
    .select('*')
    .order('detected_at', { ascending: false });

  if (error) return apiError('INTERNAL_ERROR', 'Could not load withdrawal events.');

  return apiSuccess({ events: events ?? [] });
}
