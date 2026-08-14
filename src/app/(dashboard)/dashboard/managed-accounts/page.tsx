import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default async function ManagedAccountsPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetch below, not a real runtime path.
    return null;
  }

  const { data: accounts } = await supabase
    .from('managed_accounts')
    .select('id, tier, status, created_at')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  const onlyAccount = accounts && accounts.length === 1 ? accounts[0] : null;
  if (onlyAccount) {
    redirect(`/dashboard/managed-accounts/${onlyAccount.id}`);
  }

  if (!accounts || accounts.length === 0) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">
            You don&apos;t have a Managed Account yet
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
            VaultPoint trades a segregated sub-account on your behalf, under a signed
            authorization you control. This is a formal onboarding process, not a subscription
            upgrade.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/managed-accounts/new">Open a Managed Account</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="font-display text-xl font-semibold text-text-primary">Managed Accounts</h1>
      <div className="space-y-2">
        {accounts.map((account) => (
          <Link key={account.id} href={`/dashboard/managed-accounts/${account.id}`}>
            <Card className="flex items-center justify-between hover:border-accent">
              <div>
                <p className="text-sm font-semibold capitalize text-text-primary">{account.tier}</p>
                <p className="text-xs text-text-tertiary capitalize">{account.status.replace(/_/g, ' ')}</p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
