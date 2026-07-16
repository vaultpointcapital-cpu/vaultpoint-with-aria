'use client';

import { formatDistanceToNow } from 'date-fns';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import type { AlertHistoryEntry } from '@/types/database';

interface AlertHistoryListProps {
  history: AlertHistoryEntry[];
}

export function AlertHistoryList({ history }: AlertHistoryListProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>

      {history.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-tertiary">
          No alerts have fired yet. Once one triggers, it&apos;ll show up here.
        </p>
      ) : (
        <div className="space-y-1">
          {history.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-none"
            >
              <div className="min-w-0">
                <p className="text-sm text-text-primary">{entry.message}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {entry.delivered_via.map((channel) => (
                    <span
                      key={channel}
                      className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary"
                    >
                      via {channel}
                    </span>
                  ))}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono-num text-sm text-text-secondary">{entry.triggered_value}</p>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
