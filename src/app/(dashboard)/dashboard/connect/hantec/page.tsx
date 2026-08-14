import { createClient } from '@/lib/supabase/server';
import { AddBrokerClient } from '@/components/brokers/add-broker-client';

export default async function ConnectHantecPage({ searchParams }: { searchParams: { vp_ref?: string } }) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard, not a real runtime path.
    return null;
  }

  return (
    <AddBrokerClient
      lockedBroker="metatrader"
      lockedAccountType="simulated"
      vpRef={searchParams.vp_ref}
      title="Connect your Hantec Trader account"
      description="Read-only MT5 connection — use your investor password. VaultPoint can never trade this account."
    />
  );
}
