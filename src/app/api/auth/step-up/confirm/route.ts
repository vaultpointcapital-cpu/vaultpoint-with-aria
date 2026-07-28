import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { confirmStepUpSchema } from '@/lib/validations/step-up';
import { confirmStepUp } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/step-up/confirm
 *
 * Step-Up Auth Ticket 2. Idempotent: redelivering the same approval_id
 * returns its existing outcome rather than re-verifying or erroring (spec's
 * own "must validate the approval hasn't already been resolved" rule,
 * enforced at the DB level by confirm_step_up_approval()'s row lock).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = confirmStepUpSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid confirm request.', parsed.error.flatten());
  }

  try {
    const outcome = await confirmStepUp({
      userId: authData.user.id,
      approvalToken: parsed.data.approval_id,
      method: parsed.data.method,
      signedResponse: parsed.data.signed_response,
      totpCode: parsed.data.totp_code,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'NOT_FOUND') {
        return apiError('NOT_FOUND', 'Step-up approval not found or you do not have access to it.');
      }
      if (outcome.reason === 'INVALID_TOKEN') {
        return apiError('VALIDATION_ERROR', 'This approval_id is malformed or was signed with a different key.');
      }
      return apiError(
        'VALIDATION_ERROR',
        `Method "${parsed.data.method}" is not available for this approval.`
      );
    }

    return apiSuccess({ status: outcome.status });
  } catch (err) {
    console.error('[auth/step-up/confirm] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not confirm this step-up approval.');
  }
}
