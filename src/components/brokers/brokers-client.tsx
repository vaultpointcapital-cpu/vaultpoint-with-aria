'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Link2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrokerConnectionCard } from '@/components/brokers/broker-connection-card';
import { ReauthorizeConnectionDialog } from '@/components/brokers/reauthorize-connection-dialog';
import { ManagedModeDialog } from '@/components/brokers/managed-mode-dialog';
import type { BrokerConnectionSummary } from '@/components/brokers/types';
import type { SubscriptionTier } from '@/types/database';

interface BrokersClientProps {
  initialConnections: BrokerConnectionSummary[];
  subscriptionTier: SubscriptionTier;
}

export function BrokersClient({ initialConnections, subscriptionTier }: BrokersClientProps) {
  const [connections, setConnections] = useState<BrokerConnectionSummary[]>(initialConnections);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [authorizeTarget, setAuthorizeTarget] = useState<BrokerConnectionSummary | null>(null);
  const [managedModeTarget, setManagedModeTarget] = useState<BrokerConnectionSummary | null>(null);

  function handleReauthorized(updated: BrokerConnectionSummary) {
    setConnections((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
  }

  function handleManagedModeEnabled(updated: BrokerConnectionSummary) {
    setConnections((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
  }

  async function handleDisableManagedMode(id: string) {
    const res = await fetch(`/api/brokers/${id}/managed-mode`, { method: 'DELETE' });
    if (!res.ok) return;
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, managed_mode_enabled: false } : c)));
  }

  async function refetchConnections() {
    const res = await fetch('/api/brokers');
    if (!res.ok) return;
    const { connections: fresh } = await res.json();
    setConnections(fresh);
  }

  async function handleSyncNow() {
    setIsSyncing(true);
    setSyncMessage(null);

    const res = await fetch('/api/brokers/sync', { method: 'POST' });

    if (res.status === 429) {
      setSyncMessage('You just synced — try again shortly.');
      setIsSyncing(false);
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setSyncMessage(body?.error ?? 'Sync failed. Please try again.');
      setIsSyncing(false);
      return;
    }

    // Positions are up to ~60s stale by design even under normal operation
    // — this manual sync just requests an out-of-cycle poll, it doesn't
    // guarantee the row we just read back reflects it instantly, but the
    // service call itself completes synchronously so re-fetching now
    // shows the result of THIS sync, not a stale prior one.
    await refetchConnections();
    setSyncMessage('Synced.');
    setIsSyncing(false);
  }

  async function handleDisconnect(id: string) {
    const res = await fetch(`/api/brokers/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }

  if (connections.length === 0) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
          <Link2 className="h-7 w-7 text-accent" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">
            Connect your first broker
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
            Link a read-only API key from Bybit, Binance, KuCoin, or MetaTrader to start syncing
            your live positions.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/brokers/add">Connect a broker</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-text-primary">Brokers</h1>
        <div className="flex items-center gap-3">
          {syncMessage && <p className="text-xs text-text-tertiary">{syncMessage}</p>}
          <Button variant="outline" onClick={handleSyncNow} isLoading={isSyncing}>
            <RefreshCw className="h-3.5 w-3.5" />
            Sync now
          </Button>
          <Button asChild>
            <Link href="/dashboard/brokers/add">+ Connect broker</Link>
          </Button>
        </div>
      </div>

      {/* Data is up to ~60s stale by design (the sync service polls on a
          60s cycle) — this is expected, not an error state. */}
      <p className="text-xs text-text-tertiary">
        Positions sync automatically about once a minute. Broker outages keep your last known
        data visible rather than clearing it.
      </p>

      <div className="space-y-2">
        {connections.map((connection) => (
          <BrokerConnectionCard
            key={connection.id}
            connection={connection}
            subscriptionTier={subscriptionTier}
            onDisconnect={handleDisconnect}
            onAuthorizeExecutionClick={setAuthorizeTarget}
            onManagedModeClick={setManagedModeTarget}
            onDisableManagedMode={handleDisableManagedMode}
          />
        ))}
      </div>

      <ReauthorizeConnectionDialog
        connection={authorizeTarget}
        onOpenChange={(open) => {
          if (!open) setAuthorizeTarget(null);
        }}
        onReauthorized={handleReauthorized}
      />

      <ManagedModeDialog
        connection={managedModeTarget}
        onOpenChange={(open) => {
          if (!open) setManagedModeTarget(null);
        }}
        onEnabled={handleManagedModeEnabled}
      />
    </div>
  );
}
