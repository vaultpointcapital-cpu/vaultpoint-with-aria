import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * PATCH /api/managed-accounts/:id/notifications/:notificationId
 * Marks one notification read. read_at is a UI unread-badge flag only —
 * it never suppresses future drawdown_warning inserts (see
 * maybeNotifyDrawdownWarning's dedupe, which checks created_at, not
 * read_at).
 */
export async function PATCH(_request: Request, { params }: { params: { id: string; notificationId: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('managed_account_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', params.notificationId)
    .eq('managed_account_id', params.id)
    .eq('user_id', authData.user.id)
    .select('id, read_at')
    .single();

  if (error || !data) {
    return apiError('NOT_FOUND', 'Notification not found.');
  }

  return apiSuccess({ notification: data });
}
