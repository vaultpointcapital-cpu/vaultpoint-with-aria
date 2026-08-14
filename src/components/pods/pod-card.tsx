'use client';

import { CheckCircle2 } from 'lucide-react';
import { formatDistanceToNowStrict, isPast } from 'date-fns';
import { Card } from '@/components/ui/card';
import { PodArc } from '@/components/pods/pod-arc';
import { formatCurrency, calculateProgressPct } from '@/lib/utils/cn';
import type { SavingsPod } from '@/types/database';

interface PodCardProps {
  pod: SavingsPod;
  onClick: () => void;
}

export function PodCard({ pod, onClick }: PodCardProps) {
  const isComplete = pod.current_amount >= pod.target_amount;
  const progress = calculateProgressPct(pod.current_amount, pod.target_amount);
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
      <div className="flex items-start gap-3">
        <PodArc progress={progress} color={pod.color} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{pod.name}</p>

          {isComplete ? (
            <div className="mt-2 flex items-center gap-1.5 text-sm font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              Goal reached
            </div>
          ) : (
            <p className="mt-1 font-mono-num text-xs text-text-secondary">
              {Math.round(progress)}% funded
            </p>
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
        </div>
      </div>
    </Card>
  );
}
