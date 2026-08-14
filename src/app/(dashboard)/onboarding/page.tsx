import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { OnboardingChecklist } from '@/components/onboarding/onboarding-checklist';

export default async function OnboardingPage() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('full_name, onboarding_completed, academy_student')
    .eq('id', authData.user.id)
    .single();

  if (profile?.onboarding_completed) {
    redirect('/dashboard');
  }

  return (
    <OnboardingChecklist
      userName={profile?.full_name ?? null}
      academyStudent={profile?.academy_student ?? false}
    />
  );
}
