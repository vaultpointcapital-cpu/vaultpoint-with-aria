import { createClient } from '@/lib/supabase/server';
import { AlertsClient } from '@/components/alerts/alerts-client';

export default async function AlertsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [alertsResult, historyResult, profileResult] = await Promise.all([
    supabase
      .from('alerts')
      .select('*')
      .eq('user_id', authData.user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('alert_history')
      .select('*')
      .eq('user_id', authData.user.id)
      .order('created_at', { ascending: false }),
    supabase.from('users').select('subscription_tier').eq('id', authData.user.id).single(),
  ]);

  const alerts = alertsResult.data ?? [];
  const history = historyResult.data ?? [];
  const subscriptionTier = profileResult.data?.subscription_tier ?? 'free';

  return (
    <AlertsClient initialAlerts={alerts} initialHistory={history} subscriptionTier={subscriptionTier} />
  );
}
