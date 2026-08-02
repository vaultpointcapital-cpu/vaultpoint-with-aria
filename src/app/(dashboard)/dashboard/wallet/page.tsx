import { createClient } from '@/lib/supabase/server';
import { WalletClient } from '@/components/wallet/wallet-client';

export default async function WalletPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [walletsResult, transactionsResult] = await Promise.all([
    supabase.from('wallets').select('currency, balance_cached, updated_at').eq('user_id', authData.user.id),
    supabase
      .from('wallet_transactions')
      .select('id, type, amount, currency, status, provider, provider_reference, metadata, created_at')
      .eq('user_id', authData.user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(20),
  ]);

  return (
    <WalletClient initialWallets={walletsResult.data ?? []} initialTransactions={transactionsResult.data ?? []} />
  );
}
