'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Link2, Target, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils/cn';

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  completed: boolean;
}

/**
 * Onboarding checklist shown on first login. Steps are intentionally
 * skippable — per the PRD, a trader should be able to reach the
 * dashboard immediately even with zero brokers connected, since seeing
 * an empty state is what motivates connecting the first broker.
 */
export function OnboardingChecklist({ userName }: { userName: string | null }) {
  const router = useRouter();
  const [isCompleting, setIsCompleting] = useState(false);

  const steps: OnboardingStep[] = [
    {
      id: 'connect-broker',
      title: 'Connect a broker',
      description: 'Link Bybit, Binance, KuCoin, or MetaTrader with a read-only API key',
      icon: <Link2 className="h-5 w-5" />,
      href: '/dashboard/brokers/add',
      completed: false,
    },
    {
      id: 'create-pod',
      title: 'Start a Savings Pod',
      description: 'Set a savings goal — trading capital, a trip, anything',
      icon: <Target className="h-5 w-5" />,
      href: '/dashboard/pods/new',
      completed: false,
    },
  ];

  async function handleSkip() {
    setIsCompleting(true);
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await supabase
        .from('users')
        .update({ onboarding_completed: true })
        .eq('id', data.user.id);
    }
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold text-text-primary">
            Welcome{userName ? `, ${userName}` : ''}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Two quick steps to get the most out of VaultPoint — or skip straight to your
            dashboard.
          </p>
        </div>

        <div className="space-y-3">
          {steps.map((step) => (
            <Card
              key={step.id}
              className="flex items-center gap-4 cursor-pointer transition-colors hover:border-accent"
              onClick={() => router.push(step.href)}
            >
              <div
                className={cn(
                  'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg',
                  step.completed ? 'bg-success/10 text-success' : 'bg-accent/10 text-accent'
                )}
              >
                {step.completed ? <Check className="h-5 w-5" /> : step.icon}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">{step.title}</p>
                <p className="text-xs text-text-tertiary">{step.description}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-text-tertiary" />
            </Card>
          ))}
        </div>

        <Button
          variant="ghost"
          className="mt-6 w-full"
          onClick={handleSkip}
          isLoading={isCompleting}
        >
          Skip for now — take me to my dashboard
        </Button>
      </div>
    </div>
  );
}
