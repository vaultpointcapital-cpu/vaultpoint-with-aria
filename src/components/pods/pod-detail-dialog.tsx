'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formatDistanceToNowStrict, isPast } from 'date-fns';
import { contributeToPodSchema, type ContributeToPodInput } from '@/lib/validations/pods';
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
import { formatCurrency } from '@/lib/utils/cn';
import { calculatePodProgress } from '@/lib/utils/financial';
import type { SavingsPod } from '@/types/database';

interface PodDetailDialogProps {
  pod: SavingsPod;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContributed: (podId: string, newCurrentAmount: number) => void;
}

export function PodDetailDialog({ pod, open, onOpenChange, onContributed }: PodDetailDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ContributeToPodInput>({
    resolver: zodResolver(contributeToPodSchema),
  });

  const isComplete = pod.current_amount >= pod.target_amount;
  const progress = calculatePodProgress(pod.current_amount, pod.target_amount);
  const deadlineDate = pod.deadline ? new Date(pod.deadline) : null;

  async function onSubmit(data: ContributeToPodInput) {
    setServerError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/pods/${pod.id}/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not log contribution. Please try again.');
      return;
    }

    const { newCurrentAmount } = await res.json();
    onContributed(pod.id, newCurrentAmount);
    reset({ amount: undefined, note: '' });
    setSuccessMessage('Contribution added.');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setServerError(null);
          setSuccessMessage(null);
          reset({ amount: undefined, note: '' });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: pod.color }}
              aria-hidden
            />
            <DialogTitle>{pod.name}</DialogTitle>
          </div>
          <DialogDescription>
            {deadlineDate
              ? isPast(deadlineDate)
                ? 'Deadline passed'
                : `${formatDistanceToNowStrict(deadlineDate)} left`
              : 'No deadline set'}
          </DialogDescription>
        </DialogHeader>

        {isComplete ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4" />
            Goal reached
          </div>
        ) : (
          <div className="mb-4 h-1.5 w-full rounded-full bg-border">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progress}%`, backgroundColor: pod.color }}
            />
          </div>
        )}

        <div className="mb-6 flex items-center justify-between font-mono-num text-sm text-text-secondary">
          <span>{formatCurrency(pod.current_amount, pod.currency)}</span>
          <span>{formatCurrency(pod.target_amount, pod.currency)}</span>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
              {serverError}
            </div>
          )}
          {successMessage && (
            <div
              role="status"
              className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
            >
              {successMessage}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="amount">Contribution amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              placeholder="100"
              {...register('amount')}
            />
            {errors.amount && <p className="text-xs text-warning">{errors.amount.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" placeholder="Bonus deposit" {...register('note')} />
            {errors.note && <p className="text-xs text-warning">{errors.note.message}</p>}
          </div>

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Add contribution
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
