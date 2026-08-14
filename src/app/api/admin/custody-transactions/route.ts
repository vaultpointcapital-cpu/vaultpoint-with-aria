import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/admin/custody-transactions — every custody transaction. A
 * status='pending_review' row is the review queue itself (spec 4.3.4);
 * this route returns everything so the admin UI can filter client-side,
 * same shape as /api/admin/withdrawal-events and /api/admin/disputes.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: transactions, error } = await admin
    .from('custody_transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return apiError('INTERNAL_ERROR', 'Could not load custody transactions.');

  return apiSuccess({ transactions: transactions ?? [] });
}
