import { createClient } from '@/lib/supabase/server';
import { SettingsClient } from '@/components/settings/settings-client';

export default async function SettingsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [profileResult, subscriptionResult, brokerCountResult, academyVideosResult] = await Promise.all([
    supabase
      .from('users')
      .select('full_name, country_code, subscription_tier, academy_student, created_at')
      .eq('id', authData.user.id)
      .single(),
    supabase
      .from('subscriptions')
      .select('current_period_end, status')
      .eq('user_id', authData.user.id)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('broker_connections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', authData.user.id),
    supabase
      .from('academy_videos')
      .select('*')
      .eq('video_type', 'long_form')
      .eq('is_active', true)
      .order('display_order', { ascending: true }),
  ]);

  return (
    <SettingsClient
      email={authData.user.email ?? ''}
      profile={profileResult.data}
      currentPeriodEnd={subscriptionResult.data?.current_period_end ?? null}
      connectedBrokerCount={brokerCountResult.count ?? 0}
      academyVideos={academyVideosResult.data ?? []}
    />
  );
}
