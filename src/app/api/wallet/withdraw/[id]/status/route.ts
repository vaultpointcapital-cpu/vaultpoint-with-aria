import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/wallet/withdraw/:id/status
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const { data: withdrawalRequest } = await supabase
    .from('withdrawal_requests')
    .select('id, amount, currency, destination_type, status, requested_at, processed_at')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (!withdrawalRequest) {
    return apiError('NOT_FOUND', 'Withdrawal request not found or you do not have access to it.');
  }

  return apiSuccess({ withdrawalRequest });
}
