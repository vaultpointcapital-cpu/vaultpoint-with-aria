import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/managed-accounts/:id/notifications
 * Onboarding milestones, distribution/withdrawal-window notices, and
 * drawdown warnings for one account — scoped the same way every other
 * nested managed-accounts route is (:id in the path, RLS as the final
 * backstop via the select-own-rows policy).
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  const { data, error } = await supabase
    .from('managed_account_notifications')
    .select('id, type, title, body, read_at, created_at')
    .eq('managed_account_id', account.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load notifications.');
  }

  return apiSuccess({ notifications: data });
}
