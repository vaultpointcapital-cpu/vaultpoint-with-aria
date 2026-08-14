import { createClient } from '@/lib/supabase/server';
import { AddBrokerClient } from '@/components/brokers/add-broker-client';

export default async function AddBrokerPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard, not a real runtime path.
    return null;
  }

  return <AddBrokerClient />;
}
