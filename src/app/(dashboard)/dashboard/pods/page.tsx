import { createClient } from '@/lib/supabase/server';
import { PodsClient } from '@/components/pods/pods-client';

export default async function PodsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [podsResult, profileResult] = await Promise.all([
    supabase
      .from('savings_pods')
      .select('*')
      .eq('user_id', authData.user.id)
      .neq('status', 'archived')
      .order('created_at', { ascending: false }),
    supabase.from('users').select('subscription_tier').eq('id', authData.user.id).single(),
  ]);

  const pods = podsResult.data ?? [];
  const subscriptionTier = profileResult.data?.subscription_tier ?? 'free';

  return <PodsClient initialPods={pods} subscriptionTier={subscriptionTier} />;
}
