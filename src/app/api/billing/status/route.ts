import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier, status, payment_provider, current_period_end')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const tier = subscription?.tier ?? 'free';

  return apiSuccess({
    tier,
    // A user with no subscriptions row at all is on the free tier by
    // default, which has nothing to bill — 'active' reflects that, not
    // a real provider-reported status.
    status: subscription?.status ?? 'active',
    provider: subscription?.payment_provider ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    canUpgrade: tier !== 'elite',
  });
}
