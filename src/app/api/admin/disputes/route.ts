import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/admin/disputes — every dispute, for the admin list view.
 * SLA status itself is computed client-side (computeSlaStatus, src/lib/
 * validations/disputes.ts) from the raw opened_at/acknowledged_at/
 * resolved_at/status/tier fields returned here, so the list and the
 * SLA-breach cron always agree on what "breached" means from the same
 * inputs.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: disputes, error } = await admin.from('disputes').select('*').order('opened_at', { ascending: false });

  if (error) return apiError('INTERNAL_ERROR', 'Could not load disputes.');

  return apiSuccess({ disputes: disputes ?? [] });
}
