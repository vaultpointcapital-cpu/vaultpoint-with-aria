'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { BrokerConnectionSummary } from '@/components/brokers/types';
import type { BrokerType, SyncStatus } from '@/types/database';

const BROKER_LABELS: Record<BrokerType, string> = {
  bybit: 'Bybit',
  binance: 'Binance',
  kucoin: 'KuCoin',
  metatrader: 'MetaTrader',
};

const STATUS_STYLES: Record<SyncStatus, string> = {
  pending: 'bg-info/10 text-info',
  connected: 'bg-success/10 text-success',
  error: 'bg-warning/10 text-warning',
  disconnected: 'bg-surface-elevated text-text-tertiary',
};

const STATUS_LABELS: Record<SyncStatus, string> = {
  pending: 'Connecting',
  connected: 'Connected',
  error: 'Error',
  disconnected: 'Disconnected',
};

interface BrokerConnectionCardProps {
  connection: BrokerConnectionSummary;
  onDisconnect: (id: string) => Promise<void>;
  onAuthorizeExecutionClick: (connection: BrokerConnectionSummary) => void;
}

export function BrokerConnectionCard({
  connection,
  onDisconnect,
  onAuthorizeExecutionClick,
}: BrokerConnectionCardProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!window.confirm(`Disconnect ${connection.label}? VaultPoint will stop syncing this account.`)) {
      return;
    }
    setIsDisconnecting(true);
    await onDisconnect(connection.id);
    // No need to reset — the card unmounts once removed from the parent's list.
  }

  return (
    <Card className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-text-primary">{connection.label}</p>
          <span className="text-xs text-text-tertiary">{BROKER_LABELS[connection.broker]}</span>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              STATUS_STYLES[connection.sync_status]
            )}
          >
            {STATUS_LABELS[connection.sync_status]}
          </span>
        </div>

        {/* Always show what we last knew, regardless of current status —
            a broker outage or sync error should never make this look like
            there's no data, only that it isn't fresh right now. */}
        <p className="mt-1 text-xs text-text-tertiary">
          {connection.last_synced_at
            ? `Last updated ${formatDistanceToNow(new Date(connection.last_synced_at), { addSuffix: true })}`
            : 'Never synced yet'}
        </p>

        {connection.sync_status === 'error' && connection.last_error && (
          <p className="mt-1.5 max-w-md text-xs text-warning">{connection.last_error}</p>
        )}

        {connection.trade_execution_enabled ? (
          <p className="mt-1.5 text-xs font-medium text-success">Authorized for Signal Mode execution</p>
        ) : (
          <button
            type="button"
            onClick={() => onAuthorizeExecutionClick(connection)}
            className="mt-1.5 text-xs font-medium text-accent hover:underline"
          >
            Authorize for trade execution
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={handleDisconnect}
        disabled={isDisconnecting}
        aria-label={`Disconnect ${connection.label}`}
        className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </Card>
  );
}
