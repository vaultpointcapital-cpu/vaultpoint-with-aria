'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { ProfileForm } from '@/components/settings/profile-form';
import { PasswordForm } from '@/components/settings/password-form';
import { DangerZone } from '@/components/settings/danger-zone';
import { AcademyVideosSection } from '@/components/academy/academy-videos-section';
import type { AcademyVideo, SubscriptionTier } from '@/types/database';

interface ProfileSummary {
  full_name: string | null;
  country_code: string | null;
  subscription_tier: SubscriptionTier;
  academy_student: boolean;
  created_at: string;
}

interface SettingsClientProps {
  email: string;
  profile: ProfileSummary | null;
  currentPeriodEnd: string | null;
  connectedBrokerCount: number;
  academyVideos: AcademyVideo[];
}

export function SettingsClient({
  email,
  profile,
  currentPeriodEnd,
  connectedBrokerCount,
  academyVideos,
}: SettingsClientProps) {
  const router = useRouter();
  const tier = profile?.subscription_tier ?? 'free';

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <h1 className="font-display text-xl font-semibold text-text-primary">Settings</h1>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <ProfileForm
          initialFullName={profile?.full_name ?? ''}
          initialCountryCode={profile?.country_code ?? ''}
        />
        <div className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary">Email</span>
            <span className="text-text-secondary">{email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-tertiary">Meir FX Academy</span>
            <span className="text-text-secondary">
              {profile?.academy_student ? 'Verified member' : 'Not linked'}
            </span>
          </div>
        </div>
      </Card>

      <AcademyVideosSection videos={academyVideos} />

      {/* Subscription */}
      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-text-primary">{tier}</p>
            {currentPeriodEnd && (
              <p className="mt-0.5 text-xs text-text-tertiary">
                Renews {new Date(currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          {/* Billing isn't built yet — plain text, not a clickable link,
              same pattern as the Markets page's Aria-locked state. */}
          <p className="text-xs font-medium text-text-tertiary">
            {tier === 'free' ? 'Upgrade' : 'Manage billing'} — coming soon
          </p>
        </div>
      </Card>

      {/* Connected brokers — links out rather than duplicating CRUD here */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Connected Brokers</CardTitle>
          <Link href="/dashboard/brokers" className="text-xs font-medium text-accent hover:underline">
            Manage →
          </Link>
        </CardHeader>
        <p className="text-sm text-text-secondary">
          {connectedBrokerCount} broker{connectedBrokerCount === 1 ? '' : 's'} connected
        </p>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <PasswordForm />
        <div className="mt-4 border-t border-border pt-4">
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </Card>

      {/* Danger zone */}
      <DangerZone />
    </div>
  );
}
