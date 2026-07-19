import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OnboardingWizard } from '@/components/managed-accounts/onboarding-wizard';

export default async function NewManagedAccountPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetch below, not a real runtime path.
    return null;
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  const subscriptionTier = profile?.subscription_tier ?? 'free';

  // Free-tier users can't unlock any Managed Tier (see
  // MANAGED_TIER_MIN_SUBSCRIPTION) — route them to the upgrade flow
  // rather than showing a wizard every step of which will fail.
  if (subscriptionTier === 'free') {
    redirect('/dashboard/settings?upgrade=managed-accounts');
  }

  return <OnboardingWizard subscriptionTier={subscriptionTier} />;
}
