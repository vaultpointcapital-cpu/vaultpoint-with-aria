import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DashboardNav } from '@/components/layout/dashboard-nav';
import { SessionTracker } from '@/components/analytics/session-tracker';

/**
 * Layout for every route under (dashboard)/. Runs the auth check
 * server-side on every request — this is the actual security boundary,
 * not just a client-side redirect that a fast page load could briefly
 * bypass.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('full_name, subscription_tier, onboarding_completed')
    .eq('id', authData.user.id)
    .single();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SessionTracker />
      <DashboardNav
        userName={profile?.full_name ?? null}
        tier={profile?.subscription_tier ?? 'free'}
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
