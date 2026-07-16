import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { updateProfileSchema } from '@/lib/validations/settings';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { User } from '@/types/database';

/**
 * PATCH /api/users/me
 * Updates the caller's own profile — full_name/country_code only.
 * updateProfileSchema has no subscription_tier field, and Zod strips
 * unknown keys by default, so there is no code path here that could ever
 * write subscription_tier even if a client sent it in the body — that
 * column is only ever set by the billing webhook (once built).
 */
export async function PATCH(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid profile data.', parsed.error.flatten());
  }

  const updatePayload: Partial<User> = {};
  if (parsed.data.fullName !== undefined) updatePayload.full_name = parsed.data.fullName;
  if (parsed.data.countryCode !== undefined) updatePayload.country_code = parsed.data.countryCode;

  const { data, error } = await supabase
    .from('users')
    .update(updatePayload)
    .eq('id', authData.user.id)
    .select()
    .single();

  if (error) {
    console.error('[users/me PATCH] Could not update profile:', error);
    return apiError('INTERNAL_ERROR', 'Could not update your profile.');
  }

  return apiSuccess({ user: data });
}

/**
 * DELETE /api/users/me
 * Permanently deletes the caller's own account. Only ever targets
 * authData.user.id — sourced from the verified session, never from
 * client input — so this can't be used to delete anyone else's account.
 *
 * Deletes via the auth admin API (requires the service-role key, hence
 * this route rather than a direct client call) against auth.users, which
 * cascades through public.users to every dependent table — broker_
 * connections (and its encrypted API keys), positions, portfolio_
 * snapshots, manual_assets, savings_pods, pod_contributions, alerts,
 * alert_history, subscriptions — all declared ON DELETE CASCADE in
 * supabase/migrations/20260617000000_initial_schema.sql. Verified before
 * building this route, per the spec's own explicit condition: no
 * orphaned encrypted credentials or other data is left behind.
 */
export async function DELETE() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const serviceClient = createServiceClient();
  const { error } = await serviceClient.auth.admin.deleteUser(authData.user.id);

  if (error) {
    console.error('[users/me DELETE] Could not delete user:', error);
    return apiError('INTERNAL_ERROR', 'Could not delete your account. Please try again or contact support.');
  }

  return apiSuccess({ deleted: true });
}
