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
  /** Always-visible reassurance line — for the one thing worth stating
   * up front, not hidden behind a click (currently just the broker
   * step's "we can't touch your money" line). */
  reassurance?: string;
  /** Longer explanation behind a "What's this?" toggle — for context
   * that would clutter the card if always shown. */
  helpText?: string;
  icon: React.ReactNode;
  href: string;
  completed: boolean;
}

/**
 * Onboarding checklist shown on first login. Steps are intentionally
 * skippable — per the PRD, a trader should be able to reach the
 * dashboard immediately even with zero brokers connected, since seeing
 * an empty state is what motivates connecting the first broker.
 *
 * The reassurance/help-text additions below target one specific
 * audience — Meir FX Academy students who may never have generated a
 * broker API key before — without restructuring the flow itself: same
 * two steps, same skip button, same routing.
 */
export function OnboardingChecklist({
  userName,
  academyStudent,
}: {
  userName: string | null;
  academyStudent: boolean;
}) {
  const router = useRouter();
  const [isCompleting, setIsCompleting] = useState(false);
  const [expandedHelpStepId, setExpandedHelpStepId] = useState<string | null>(null);

  const steps: OnboardingStep[] = [
    {
      id: 'connect-broker',
      title: 'Connect a broker',
      description: 'Link Bybit, Binance, KuCoin, or MetaTrader with a read-only API key',
      reassurance:
        'Read-only means VaultPoint can see your balance and trades, but can never place a trade or move funds.',
      helpText:
        "An API key lets VaultPoint read your account balance and trades — it can't move your money or place trades. You'll find this in your broker's account settings, usually under \"API Management.\"",
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

  const namePart = userName ? `, ${userName}` : '';
  const welcomeHeading = academyStudent
    ? `Welcome${namePart} — good to see a Meir FX Academy member here.`
    : `Welcome${namePart}`;
  const welcomeSubtext = academyStudent
    ? 'Two quick steps to get set up, or skip straight to your dashboard.'
    : 'Two quick steps to get the most out of VaultPoint — or skip straight to your dashboard.';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold text-text-primary">{welcomeHeading}</h1>
          <p className="mt-2 text-sm text-text-secondary">{welcomeSubtext}</p>
        </div>

        <div className="space-y-3">
          {steps.map((step) => {
            const isHelpExpanded = expandedHelpStepId === step.id;

            return (
              <Card
                key={step.id}
                className="cursor-pointer transition-colors hover:border-accent"
                onClick={() => router.push(step.href)}
              >
                <div className="flex items-center gap-4">
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
                    {step.reassurance && (
                      <p className="mt-1 text-xs text-text-tertiary">{step.reassurance}</p>
                    )}
                    {step.helpText && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedHelpStepId(isHelpExpanded ? null : step.id);
                        }}
                        className="mt-1 text-xs font-medium text-accent-light hover:underline"
                      >
                        {isHelpExpanded ? 'Hide' : "What's this?"}
                      </button>
                    )}
                  </div>
                  <ArrowRight className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
                </div>

                {step.helpText && isHelpExpanded && (
                  <p
                    onClick={(e) => e.stopPropagation()}
                    className="mt-3 rounded-lg bg-surface-elevated p-3 text-xs text-text-secondary"
                  >
                    {step.helpText}
                  </p>
                )}
              </Card>
            );
          })}
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
