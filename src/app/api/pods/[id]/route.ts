import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createPodSchema } from '@/lib/validations/pods';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * PATCH /api/pods/:id
 * Updates a savings pod's editable fields (name, target, deadline, color).
 * Does not allow updating current_amount directly — that's only ever
 * changed via POST /api/pods/:id/contribute, which writes an auditable
 * pod_contributions row alongside it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = createPodSchema.partial().safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid pod data.', parsed.error.flatten());
  }

  const updatePayload: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
  if (parsed.data.targetAmount !== undefined) updatePayload.target_amount = parsed.data.targetAmount;
  if (parsed.data.color !== undefined) updatePayload.color = parsed.data.color;
  if (parsed.data.deadline !== undefined) updatePayload.deadline = parsed.data.deadline;

  const { data, error } = await supabase
    .from('savings_pods')
    .update(updatePayload)
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select()
    .single();

  if (error) {
    return apiError('NOT_FOUND', 'Pod not found or you do not have access to it.');
  }

  return apiSuccess({ pod: data });
}

/**
 * DELETE /api/pods/:id
 * Archives rather than hard-deletes, preserving contribution history for
 * the user's records even after they remove a pod from their active view.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { error } = await supabase
    .from('savings_pods')
    .update({ status: 'archived' })
    .eq('id', params.id)
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not archive pod.');
  }

  return apiSuccess({ archived: true });
}
