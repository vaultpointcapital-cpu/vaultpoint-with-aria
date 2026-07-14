'use client';

import { CheckCircle2 } from 'lucide-react';
import { formatDistanceToNowStrict, isPast } from 'date-fns';
import { Card } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils/cn';
import { calculatePodProgress } from '@/lib/utils/financial';
import type { SavingsPod } from '@/types/database';

interface PodCardProps {
  pod: SavingsPod;
  onClick: () => void;
}

export function PodCard({ pod, onClick }: PodCardProps) {
  const isComplete = pod.current_amount >= pod.target_amount;
  const progress = calculatePodProgress(pod.current_amount, pod.target_amount);
  const deadlineDate = pod.deadline ? new Date(pod.deadline) : null;

  return (
    <Card
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="cursor-pointer transition-colors hover:border-accent/50"
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: pod.color }}
          aria-hidden
        />
        <p className="truncate text-sm font-semibold text-text-primary">{pod.name}</p>
      </div>

      {isComplete ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success">
          <CheckCircle2 className="h-4 w-4" />
          Goal reached
        </div>
      ) : (
        <div className="mt-4 h-1.5 w-full rounded-full bg-border">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progress}%`, backgroundColor: pod.color }}
          />
        </div>
      )}

      <div className="mt-2 flex items-center justify-between font-mono-num text-xs text-text-secondary">
        <span>{formatCurrency(pod.current_amount, pod.currency)}</span>
        <span>{formatCurrency(pod.target_amount, pod.currency)}</span>
      </div>

      {deadlineDate && !isComplete && (
        <p className="mt-2 text-xs text-text-tertiary">
          {isPast(deadlineDate)
            ? 'Overdue'
            : `${formatDistanceToNowStrict(deadlineDate)} left`}
        </p>
      )}
    </Card>
  );
}
