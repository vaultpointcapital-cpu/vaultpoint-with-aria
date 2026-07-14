'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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

const COLOR_PRESETS = ['#6C63FF', '#00E5A0', '#3B9EFF', '#FF6B35', '#FFD700', '#EC4899'];

interface CreatePodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (pod: SavingsPod) => void;
}

export function CreatePodDialog({ open, onOpenChange, onCreated }: CreatePodDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<CreatePodInput>({
    resolver: zodResolver(createPodSchema),
    defaultValues: {
      currency: 'USD',
      color: COLOR_PRESETS[0],
    },
  });

  const selectedColor = watch('color');

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
    onCreated(pod);
    reset({ currency: 'USD', color: COLOR_PRESETS[0] });
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setServerError(null);
          reset({ currency: 'USD', color: COLOR_PRESETS[0] });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Savings Pod</DialogTitle>
          <DialogDescription>Set a target and start contributing whenever you like.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
              {serverError}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="New car" {...register('name')} />
            {errors.name && <p className="text-xs text-warning">{errors.name.message}</p>}
          </div>

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
              <Input
                id="currency"
                maxLength={3}
                className="uppercase"
                {...register('currency')}
              />
              {errors.currency && (
                <p className="text-xs text-warning">{errors.currency.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="deadline">Deadline (optional)</Label>
            <Input id="deadline" type="date" {...register('deadline')} />
            {errors.deadline && <p className="text-xs text-warning">{errors.deadline.message}</p>}
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
                    'h-8 w-8 rounded-full transition-transform',
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

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Create pod
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
