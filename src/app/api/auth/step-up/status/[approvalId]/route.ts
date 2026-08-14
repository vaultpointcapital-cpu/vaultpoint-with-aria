import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getStepUpApprovalStatus } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/auth/step-up/status/:approvalId
 *
 * Step-Up Auth Ticket 2. approval_id is a base64url JWT (no `/` or `+`
 * characters), so it's safe to pass directly as a path segment — the
 * client doesn't need to URL-encode it.
 */
export async function GET(_request: NextRequest, { params }: { params: { approvalId: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const result = await getStepUpApprovalStatus({ userId: authData.user.id, approvalToken: params.approvalId });

  if (!result) {
    return apiError('NOT_FOUND', 'Step-up approval not found or you do not have access to it.');
  }

  return apiSuccess({ status: result.status, created_at: result.createdAt, resolved_at: result.resolvedAt });
}
