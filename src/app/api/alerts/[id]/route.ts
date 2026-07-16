import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { updateAlertSchema, canCreateAnotherAlert } from '@/lib/validations/alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { SubscriptionTier } from '@/types/database';

/**
 * PATCH /api/alerts/:id
 * Toggles is_active or edits threshold. Re-enabling a disabled alert
 * (isActive: true) re-runs the same active-alert tier-limit check POST
 * uses — otherwise a Free user at their limit could dodge it by
 * disabling one alert and re-enabling a different one instead of
 * deleting anything.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = updateAlertSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid alert data.', parsed.error.flatten());
  }

  if (parsed.data.isActive === true) {
    const { data: profile } = await supabase
      .from('users')
      .select('subscription_tier')
      .eq('id', authData.user.id)
      .single();
    const tier: SubscriptionTier = profile?.subscription_tier ?? 'free';

    const { count } = await supabase
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', authData.user.id)
      .eq('is_active', true)
      .neq('id', params.id);

    if (!canCreateAnotherAlert(tier, count ?? 0)) {
      return apiError(
        'TIER_LIMIT_REACHED',
        `Your ${tier} plan allows a limited number of active alerts. Disable another alert first.`,
        { tier, currentActiveCount: count }
      );
    }
  }

  const updatePayload: Record<string, unknown> = {};
  if (parsed.data.isActive !== undefined) updatePayload.is_active = parsed.data.isActive;
  if (parsed.data.threshold !== undefined) updatePayload.threshold = parsed.data.threshold;

  const { data, error } = await supabase
    .from('alerts')
    .update(updatePayload)
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select()
    .single();

  if (error) {
    return apiError('NOT_FOUND', 'Alert not found or you do not have access to it.');
  }

  return apiSuccess({ alert: data });
}

/**
 * DELETE /api/alerts/:id
 * Hard-deletes, per this spec's acceptance criteria ("Deleting an alert
 * removes it"). Unlike pods (which archive to preserve contribution
 * history), alerts have no archived state in the schema — and note this
 * cascades: alert_history.alert_id references alerts(id) on delete
 * cascade, so any fired-alert history tied to this alert is deleted too,
 * not just the rule itself.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { error } = await supabase
    .from('alerts')
    .delete()
    .eq('id', params.id)
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not delete alert.');
  }

  return apiSuccess({ deleted: true });
}
