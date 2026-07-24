'use client';

import { useState } from 'react';
import { Trash2, TrendingUp, TrendingDown, ShieldAlert, Tag } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { describeAlert } from '@/lib/validations/alerts';
import {
  categorizeAlert,
  ALERT_CATEGORY_BORDER,
  ALERT_CATEGORY_ICON_BG,
  ALERT_CATEGORY_TEXT,
  ALERT_CATEGORY_LABEL,
  type AlertVisualCategory,
} from '@/lib/utils/alert-style';
import type { Alert } from '@/types/database';

const CATEGORY_ICON: Record<AlertVisualCategory, typeof Tag> = {
  data: Tag,
  profit: TrendingUp,
  loss: TrendingDown,
  risk: ShieldAlert,
};

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

  const category = categorizeAlert(alert.condition_type, alert.operator);
  const CategoryIcon = CATEGORY_ICON[category];

  return (
    <Card
      className={cn(
        'flex items-center justify-between gap-4 border-l-4 py-4',
        ALERT_CATEGORY_BORDER[category]
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            ALERT_CATEGORY_ICON_BG[category]
          )}
          aria-hidden
        >
          <CategoryIcon className="h-4 w-4" />
        </div>

        <div className="min-w-0">
          <span
            className={cn(
              'text-[10px] font-semibold uppercase tracking-wide',
              ALERT_CATEGORY_TEXT[category]
            )}
          >
            {ALERT_CATEGORY_LABEL[category]}
          </span>
          <p
            className={cn(
              'truncate text-sm font-medium',
              alert.is_active ? 'text-text-primary' : 'text-text-tertiary'
            )}
          >
            {describeAlert(alert)}
          </p>
          {!alert.is_active && <p className="mt-0.5 text-xs text-text-tertiary">Disabled</p>}
        </div>
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
          className="flex h-10 w-10 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </Card>
  );
}
