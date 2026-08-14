import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { tierAtLeast } from '@/lib/billing/tier-limits';
import type { SubscriptionTier } from '@/types/database';

/**
 * GET /api/signals
 * Lists active signals visible to the caller's tier, plus the caller's
 * own signal_actions against them (so the UI can gray out ones already
 * executed/skipped rather than re-offering Execute on a settled signal).
 *
 * signals.min_tier gates visibility, not signals.status — Free users
 * simply never see a min_tier='pro'/'elite' row at all (rather than
 * seeing it disabled), matching the spec's "Free: limited" framing.
 * "Delayed" delivery for Free is not implemented here — there's no
 * delivery-lag mechanism anywhere in this codebase to hook into yet.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();
  const tier: SubscriptionTier = profile?.subscription_tier ?? 'free';

  const { data: allActive, error: signalsError } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (signalsError) {
    return apiError('INTERNAL_ERROR', 'Could not load signals.');
  }

  const signals = (allActive ?? []).filter((signal) => tierAtLeast(tier, signal.min_tier));

  const { data: actions, error: actionsError } = await supabase
    .from('signal_actions')
    .select('*')
    .eq('user_id', authData.user.id)
    .in(
      'signal_id',
      signals.map((s) => s.id)
    );

  if (actionsError) {
    return apiError('INTERNAL_ERROR', 'Could not load your signal actions.');
  }

  return apiSuccess({ signals, actions: actions ?? [] });
}
