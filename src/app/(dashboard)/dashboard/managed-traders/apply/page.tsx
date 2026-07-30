import { createClient } from '@/lib/supabase/server';
import { TraderApplicationForm } from '@/components/managed-traders/trader-application-form';
import { TraderApplicationStatus } from '@/components/managed-traders/trader-application-status';

export default async function ApplyAsManagedTraderPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; type guard only.
    return null;
  }

  const [existingResult, brokerConnectionsResult] = await Promise.all([
    supabase
      .from('managed_traders')
      .select('id, status, proposed_profit_split, approved_profit_split, reviewer_notes, created_at, reviewed_at')
      .eq('user_id', authData.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('broker_connections').select('id, broker, label, created_at').eq('user_id', authData.user.id),
  ]);

  // Any existing application (any status) takes over the whole page —
  // re-applying isn't a flow this PRD describes, and the apply route
  // also refuses a duplicate pending/approved application server-side;
  // this just avoids showing a pointless form first.
  if (existingResult.data) {
    return <TraderApplicationStatus application={existingResult.data} />;
  }

  const brokerConnections = brokerConnectionsResult.data ?? [];
  const oldestConnection = brokerConnections.reduce<string | null>((oldest, conn) => {
    if (!oldest || conn.created_at < oldest) return conn.created_at;
    return oldest;
  }, null);
  const accountAgeDays = oldestConnection
    ? Math.floor((Date.now() - new Date(oldestConnection).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <TraderApplicationForm
      connectedBrokers={brokerConnections.map((c) => ({ broker: c.broker, label: c.label }))}
      accountAgeDays={accountAgeDays}
    />
  );
}
