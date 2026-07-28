'use client';

import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import confetti from 'canvas-confetti';
import { cn } from '@/lib/utils/cn';
import { createPodSchema, type CreatePodInput } from '@/lib/validations/pods';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { SavingsPod } from '@/types/database';

// Each swatch corresponds to a named design-system token in
// tailwind.config.ts (accent/success/info/warning/gold/rose) — kept as
// literal hex here because `color` is stored as a raw hex string on the
// pod row (see the DB check constraint), not as a Tailwind class name.
const COLOR_PRESETS = ['#6C63FF', '#00E5A0', '#3B9EFF', '#FF6B35', '#FFD700', '#EC4899'];

const STEPS = ['name', 'target', 'timeline', 'funding', 'launch'] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  name: 'Name your pod',
  target: 'Set a target',
  timeline: 'Pick a timeline',
  funding: 'Funding reminder',
  launch: 'Ready to launch',
};

const FUNDING_OPTIONS: { value: 'weekly' | 'biweekly' | 'monthly'; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
];

interface CreatePodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (pod: SavingsPod) => void;
}

export function CreatePodDialog({ open, onOpenChange, onCreated }: CreatePodDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [launched, setLaunched] = useState(false);
  const confettiOriginRef = useRef<HTMLDivElement>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    trigger,
    reset,
    formState: { errors },
  } = useForm<CreatePodInput>({
    resolver: zodResolver(createPodSchema),
    defaultValues: {
      currency: 'USD',
      color: COLOR_PRESETS[0],
      fundingReminder: null,
    },
  });

  const selectedColor = watch('color');
  const selectedFundingReminder = watch('fundingReminder');
  const values = watch();

  function resetWizard() {
    reset({ currency: 'USD', color: COLOR_PRESETS[0], fundingReminder: null });
    setStepIndex(0);
    setLaunched(false);
    setServerError(null);
  }

  async function goNext() {
    const fieldsByStep: Record<Step, (keyof CreatePodInput)[]> = {
      name: ['name', 'color'],
      target: ['targetAmount', 'currency'],
      timeline: ['deadline'],
      funding: ['fundingReminder'],
      launch: [],
    };
    const currentStep = STEPS[stepIndex]!;
    const valid = await trigger(fieldsByStep[currentStep]);
    if (!valid) return;
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  async function onSubmit(data: CreatePodInput) {
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/pods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not create pod. Please try again.');
      return;
    }

    const { pod } = await res.json();
    setLaunched(true);
    fireConfetti();
    onCreated(pod);

    // Let the celebration land before closing — a flat instant-close would
    // undercut the "satisfying completion" the launch step is for.
    setTimeout(() => {
      resetWizard();
      onOpenChange(false);
    }, 1600);
  }

  function fireConfetti() {
    const origin = confettiOriginRef.current?.getBoundingClientRect();
    confetti({
      particleCount: 120,
      spread: 70,
      startVelocity: 35,
      colors: [selectedColor, '#00E5A0', '#6C63FF'],
      origin: origin
        ? { x: (origin.left + origin.width / 2) / window.innerWidth, y: (origin.top + origin.height / 2) / window.innerHeight }
        : { y: 0.6 },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetWizard();
        onOpenChange(next);
      }}
    >
      <DialogContent className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>{STEP_TITLES[STEPS[stepIndex]!]}</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {STEPS.length}
          </DialogDescription>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
          >
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="overflow-hidden">
            <div
              className="flex transition-transform duration-300 ease-out"
              style={{ transform: `translateX(-${stepIndex * 100}%)` }}
            >
              {STEPS.map((step) => (
                <div key={step} className="w-full shrink-0 space-y-4 px-0.5">
                  {step === 'name' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="name">Name</Label>
                        <Input id="name" placeholder="New car" {...register('name')} />
                        {errors.name && <p className="text-xs text-warning">{errors.name.message}</p>}
                      </div>
                      <div className="space-y-2">
                        <Label>Color</Label>
                        <div className="flex gap-2">
                          {COLOR_PRESETS.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              onClick={() => setValue('color', hex, { shouldValidate: true })}
                              className={cn(
                                'h-10 w-10 rounded-full transition-transform',
                                selectedColor === hex && 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                              )}
                              style={{ backgroundColor: hex }}
                              aria-label={`Choose color ${hex}`}
                              aria-pressed={selectedColor === hex}
                            />
                          ))}
                        </div>
                        {errors.color && <p className="text-xs text-warning">{errors.color.message}</p>}
                      </div>
                    </>
                  )}

                  {step === 'target' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="targetAmount">Target amount</Label>
                        <Input
                          id="targetAmount"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="5000"
                          {...register('targetAmount')}
                        />
                        {errors.targetAmount && (
                          <p className="text-xs text-warning">{errors.targetAmount.message}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="currency">Currency</Label>
                        <Input id="currency" maxLength={3} className="uppercase" {...register('currency')} />
                        {errors.currency && (
                          <p className="text-xs text-warning">{errors.currency.message}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {step === 'timeline' && (
                    <div className="space-y-2">
                      <Label htmlFor="deadline">Deadline (optional)</Label>
                      <Input id="deadline" type="date" {...register('deadline')} />
                      {errors.deadline && <p className="text-xs text-warning">{errors.deadline.message}</p>}
                      <p className="text-xs text-text-tertiary">
                        Skip this if you&apos;d rather save at your own pace.
                      </p>
                    </div>
                  )}

                  {step === 'funding' && (
                    <div className="space-y-2">
                      <Label>Remind me to contribute</Label>
                      <div className="flex flex-wrap gap-2">
                        {FUNDING_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              setValue(
                                'fundingReminder',
                                selectedFundingReminder === opt.value ? null : opt.value,
                                { shouldValidate: true }
                              )
                            }
                            className={cn(
                              'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                              selectedFundingReminder === opt.value
                                ? 'border-accent bg-accent/10 text-accent-light'
                                : 'border-border text-text-secondary hover:border-accent/40'
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-text-tertiary">
                        This just reminds you — VaultPoint never moves money automatically. You
                        stay in control of every contribution.
                      </p>
                    </div>
                  )}

                  {step === 'launch' && (
                    <div ref={confettiOriginRef} className="space-y-3">
                      {launched ? (
                        <div className="flex flex-col items-center gap-2 py-4 text-center">
                          <div
                            className="flex h-14 w-14 items-center justify-center rounded-2xl"
                            style={{ backgroundColor: `${selectedColor}1A` }}
                          >
                            <span className="text-2xl">🎉</span>
                          </div>
                          <p className="font-display text-lg font-semibold text-text-primary">
                            {values.name} is live!
                          </p>
                          <p className="text-sm text-text-secondary">Time to start contributing.</p>
                        </div>
                      ) : (
                        <div className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: selectedColor }}
                              aria-hidden
                            />
                            <span className="font-semibold text-text-primary">{values.name}</span>
                          </div>
                          <p className="font-mono-num text-text-secondary">
                            Target: {values.targetAmount} {values.currency}
                          </p>
                          {values.deadline && (
                            <p className="text-text-secondary">By {values.deadline}</p>
                          )}
                          {selectedFundingReminder && (
                            <p className="text-text-secondary">
                              Reminder:{' '}
                              {FUNDING_OPTIONS.find((o) => o.value === selectedFundingReminder)?.label}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {!launched && (
            <div className="mt-5 flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={goBack}
                disabled={stepIndex === 0}
                className={stepIndex === 0 ? 'invisible' : undefined}
              >
                Back
              </Button>

              {stepIndex < STEPS.length - 1 ? (
                <Button type="button" onClick={goNext}>
                  Next
                </Button>
              ) : (
                <Button type="submit" isLoading={isSubmitting}>
                  Launch pod
                </Button>
              )}
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
