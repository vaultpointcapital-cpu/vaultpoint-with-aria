import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { contributeToPodSchema } from '@/lib/validations/pods';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/pods/:id/contribute
 *
 * Logs a contribution and bumps the pod's current_amount atomically via
 * the contribute_to_pod() Postgres function (see
 * supabase/migrations/20260617000001_atomic_pod_contribution.sql). Both
 * writes succeed or fail together, and the pod row is locked for the
 * transaction so two simultaneous contributions can't race each other
 * into an inconsistent total.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = contributeToPodSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid contribution data.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .rpc('contribute_to_pod', {
      p_pod_id: params.id,
      p_user_id: authData.user.id,
      p_amount: parsed.data.amount,
      p_note: parsed.data.note ?? null,
    })
    .single();

  if (error) {
    // Postgres error codes raised explicitly in the function map to
    // specific, safe-to-show messages rather than a generic 500.
    if (error.code === 'P0001') {
      return apiError('NOT_FOUND', 'Pod not found or you do not have access to it.');
    }
    if (error.code === 'P0002') {
      return apiError('VALIDATION_ERROR', 'Cannot contribute to an archived pod.');
    }
    return apiError('INTERNAL_ERROR', 'Could not log contribution.');
  }

  const result = data as { contribution_id: string; new_current_amount: number };

  return apiSuccess(
    {
      contributionId: result.contribution_id,
      newCurrentAmount: result.new_current_amount,
    },
    201
  );
}
