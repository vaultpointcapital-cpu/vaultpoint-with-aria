'use client';

import { useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertCard } from '@/components/alerts/alert-card';
import { AlertHistoryList } from '@/components/alerts/alert-history-list';
import { CreateAlertDialog } from '@/components/alerts/create-alert-dialog';
import { canCreateAnotherAlert } from '@/lib/validations/alerts';
import type { Alert, AlertHistoryEntry, SubscriptionTier } from '@/types/database';

interface AlertsClientProps {
  initialAlerts: Alert[];
  initialHistory: AlertHistoryEntry[];
  subscriptionTier: SubscriptionTier;
}

export function AlertsClient({ initialAlerts, initialHistory, subscriptionTier }: AlertsClientProps) {
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [history] = useState<AlertHistoryEntry[]>(initialHistory);
  const [createOpen, setCreateOpen] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);

  const activeCount = alerts.filter((a) => a.is_active).length;
  const canCreate = canCreateAnotherAlert(subscriptionTier, activeCount);

  function handleCreated(alert: Alert) {
    setAlerts((prev) => [alert, ...prev]);
  }

  async function handleToggle(alertId: string, isActive: boolean) {
    setLimitError(null);
    const res = await fetch(`/api/alerts/${alertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setLimitError(body?.error ?? 'Could not update alert. Please try again.');
      return;
    }

    const { alert } = await res.json();
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? alert : a)));
  }

  async function handleDelete(alertId: string) {
    const res = await fetch(`/api/alerts/${alertId}`, { method: 'DELETE' });
    if (!res.ok) return;
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
  }

  if (alerts.length === 0) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
          <Bell className="h-7 w-7 text-accent" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">
            No alerts yet — set one up so you don&apos;t have to watch the charts.
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
            Get notified when a price crosses a level, or your portfolio moves more than you&apos;d
            like.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create an alert</Button>

        <CreateAlertDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-text-primary">Alerts</h1>
        <div className="text-right">
          <span
            title={
              !canCreate
                ? `Your ${subscriptionTier} plan has reached its active alert limit. Upgrade for more.`
                : undefined
            }
          >
            <Button onClick={() => setCreateOpen(true)} disabled={!canCreate}>
              + New Alert
            </Button>
          </span>
          {!canCreate && (
            <p className="mt-1 text-xs text-text-tertiary">
              Your {subscriptionTier} plan has reached its active alert limit. Upgrade for more.
            </p>
          )}
        </div>
      </div>

      {limitError && (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          {limitError}
        </div>
      )}

      <div className="space-y-2">
        {alerts.map((alert) => (
          <AlertCard key={alert.id} alert={alert} onToggle={handleToggle} onDelete={handleDelete} />
        ))}
      </div>

      <CreateAlertDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />

      <AlertHistoryList history={history} />
    </div>
  );
}
