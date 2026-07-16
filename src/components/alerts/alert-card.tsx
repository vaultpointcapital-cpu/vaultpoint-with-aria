'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { describeAlert } from '@/lib/validations/alerts';
import type { Alert } from '@/types/database';

interface AlertCardProps {
  alert: Alert;
  onToggle: (alertId: string, isActive: boolean) => Promise<void>;
  onDelete: (alertId: string) => Promise<void>;
}

export function AlertCard({ alert, onToggle, onDelete }: AlertCardProps) {
  const [isToggling, setIsToggling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleToggle() {
    setIsToggling(true);
    await onToggle(alert.id, !alert.is_active);
    setIsToggling(false);
  }

  async function handleDelete() {
    if (!window.confirm('Delete this alert? This cannot be undone.')) return;
    setIsDeleting(true);
    await onDelete(alert.id);
    // No need to reset isDeleting on success — the card unmounts once
    // removed from the parent's list.
  }

  return (
    <Card className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className={cn('truncate text-sm font-medium', alert.is_active ? 'text-text-primary' : 'text-text-tertiary')}>
          {describeAlert(alert)}
        </p>
        {!alert.is_active && <p className="mt-0.5 text-xs text-text-tertiary">Disabled</p>}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={alert.is_active}
          aria-label={alert.is_active ? 'Disable alert' : 'Enable alert'}
          onClick={handleToggle}
          disabled={isToggling}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
            alert.is_active ? 'bg-accent' : 'bg-border'
          )}
        >
          <span
            className={cn(
              'absolute top-1 h-4 w-4 rounded-full bg-white transition-transform',
              alert.is_active ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>

        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          aria-label="Delete alert"
          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </Card>
  );
}
