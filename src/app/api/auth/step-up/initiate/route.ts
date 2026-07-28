import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { initiateStepUpSchema } from '@/lib/validations/step-up';
import { initiateStepUp } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/step-up/initiate
 *
 * Step-Up Auth Ticket 2. Path adapted the same way Ticket 1's
 * /auth/devices/register was — this codebase has no bare /auth/* route
 * space, every API route lives under src/app/api/.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = initiateStepUpSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid step-up request.', parsed.error.flatten());
  }

  try {
    const result = await initiateStepUp({
      userId: authData.user.id,
      actionType: parsed.data.action_type,
      resourceId: parsed.data.resource_id,
      metadata: parsed.data.metadata,
    });
    return apiSuccess(
      { approval_id: result.approvalId, expires_at: result.expiresAt, methods: result.methods },
      201
    );
  } catch (err) {
    console.error('[auth/step-up/initiate] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not start a step-up approval.');
  }
}
