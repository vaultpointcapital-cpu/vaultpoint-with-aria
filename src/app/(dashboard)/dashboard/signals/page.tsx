import { createClient } from '@/lib/supabase/server';
import { tierAtLeast } from '@/lib/billing/tier-limits';
import { computeTrackRecord } from '@/lib/validations/signals';
import { SignalsClient } from '@/components/signals/signals-client';
import type { SubscriptionTier } from '@/types/database';
import type { SignalWithAction } from '@/components/signals/types';

export default async function SignalsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [profileResult, signalsResult, connectionsResult, outcomesResult] = await Promise.all([
    supabase.from('users').select('subscription_tier').eq('id', authData.user.id).single(),
    supabase.from('signals').select('*').eq('status', 'active').order('created_at', { ascending: false }),
    supabase
      .from('broker_connections')
      .select('id, broker, label')
      .eq('user_id', authData.user.id)
      .eq('trade_execution_enabled', true),
    supabase.from('signal_outcomes').select('result, realized_r_multiple'),
  ]);

  const tier: SubscriptionTier = profileResult.data?.subscription_tier ?? 'free';
  const visibleSignals = (signalsResult.data ?? []).filter((signal) => tierAtLeast(tier, signal.min_tier));

  const { data: actions } = await supabase
    .from('signal_actions')
    .select('*')
    .eq('user_id', authData.user.id)
    .in(
      'signal_id',
      visibleSignals.map((s) => s.id)
    );

  const actionBySignalId = new Map((actions ?? []).map((a) => [a.signal_id, a]));
  const signalsWithActions: SignalWithAction[] = visibleSignals.map((signal) => ({
    signal,
    action: actionBySignalId.get(signal.id) ?? null,
  }));

  return (
    <SignalsClient
      initialSignals={signalsWithActions}
      executableConnections={connectionsResult.data ?? []}
      trackRecord={computeTrackRecord(outcomesResult.data ?? [])}
      subscriptionTier={tier}
    />
  );
}
