import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { updateCustodySettingsSchema } from '@/lib/validations/custody';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET/PUT /api/admin/custody-settings
 *
 * The singleton custody_settings row — the crypto withdrawal review-hold
 * threshold (spec Open Item #3). NULL blocks every crypto withdrawal
 * above $0 from auto-submitting to Cobo — see
 * src/lib/wallet/web3-adapter.ts's initiateCryptoPayout for where this
 * is enforced.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: settings, error } = await admin.from('custody_settings').select('*').eq('id', 1).single();
  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not load custody settings.');

  return apiSuccess({ settings });
}

export async function PUT(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = updateCustodySettingsSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid settings update.', parsed.error.flatten());

  const admin = createServiceClient();
  const { data: settings, error } = await admin
    .from('custody_settings')
    .update({
      withdrawal_review_hold_threshold_usd: parsed.data.withdrawalReviewHoldThresholdUsd ?? null,
      updated_by: authData.user.id,
    })
    .eq('id', 1)
    .select('*')
    .single();

  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not update custody settings.');

  return apiSuccess({ settings });
}
