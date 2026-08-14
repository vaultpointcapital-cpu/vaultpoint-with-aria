'use client';

import { useState } from 'react';
import { Radar } from 'lucide-react';
import { SignalCard } from '@/components/signals/signal-card';
import { ExecuteSignalDialog } from '@/components/signals/execute-signal-dialog';
import { TrackRecordCard } from '@/components/signals/track-record-card';
import type { Signal, SubscriptionTier } from '@/types/database';
import type { SignalWithAction, ExecutableBrokerConnection } from '@/components/signals/types';
import type { TrackRecordSummary } from '@/lib/validations/signals';

interface SignalsClientProps {
  initialSignals: SignalWithAction[];
  executableConnections: ExecutableBrokerConnection[];
  trackRecord: TrackRecordSummary;
  subscriptionTier: SubscriptionTier;
}

export function SignalsClient({
  initialSignals,
  executableConnections,
  trackRecord,
  subscriptionTier,
}: SignalsClientProps) {
  const [signals, setSignals] = useState<SignalWithAction[]>(initialSignals);
  const [executeTarget, setExecuteTarget] = useState<Signal | null>(null);
  const [skipError, setSkipError] = useState<string | null>(null);

  const canExecute = executableConnections.length > 0;

  async function refetchSignals() {
    const res = await fetch('/api/signals');
    if (!res.ok) return;
    const { signals: freshSignals, actions } = await res.json();
    const actionBySignalId = new Map(actions.map((a: { signal_id: string }) => [a.signal_id, a]));
    setSignals(
      freshSignals.map((signal: Signal) => ({
        signal,
        action: actionBySignalId.get(signal.id) ?? null,
      }))
    );
  }

  async function handleSkip(signalId: string) {
    setSkipError(null);
    const res = await fetch(`/api/signals/${signalId}/skip`, { method: 'POST' });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setSkipError(body?.error ?? 'Could not skip this signal. Please try again.');
      return;
    }

    const { action } = await res.json();
    setSignals((prev) => prev.map((item) => (item.signal.id === signalId ? { ...item, action } : item)));
  }

  if (signals.length === 0) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
          <Radar className="h-7 w-7 text-accent" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">No active signals right now</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
            {subscriptionTier === 'free'
              ? 'Free plan signal access is limited — upgrade to Pro or Elite to see the full feed.'
              : 'Check back shortly — new signals show up here as soon as they go active.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-text-primary">Signals</h1>
        {!canExecute && (
          <p className="text-xs text-text-tertiary">
            No broker connection is authorized for trade execution — re-authorize one from Brokers to
            execute signals.
          </p>
        )}
      </div>

      <TrackRecordCard trackRecord={trackRecord} />

      {skipError && (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          {skipError}
        </div>
      )}

      <div className="space-y-2">
        {signals.map((item) => (
          <SignalCard
            key={item.signal.id}
            item={item}
            canExecute={canExecute}
            onExecuteClick={setExecuteTarget}
            onSkip={handleSkip}
          />
        ))}
      </div>

      <ExecuteSignalDialog
        signal={executeTarget}
        connections={executableConnections}
        onOpenChange={(open) => {
          if (!open) setExecuteTarget(null);
        }}
        onSettled={refetchSignals}
      />
    </div>
  );
}
