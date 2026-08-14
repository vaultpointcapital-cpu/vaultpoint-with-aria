'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  CircleSlash,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { BrokerConnectionSummary } from '@/components/brokers/types';
import type { BrokerType, SubscriptionTier, HealthState } from '@/types/database';

const BROKER_LABELS: Record<BrokerType, string> = {
  bybit: 'Bybit',
  binance: 'Binance',
  kucoin: 'KuCoin',
  metatrader: 'MetaTrader',
};

// Connection Health & Data Freshness — keyed on the 6-state `health`
// column, not the legacy 4-state `sync_status` (kept as a derived,
// backward-compatible view server-side — see database.ts's HealthState
// comment — but this card reads the richer signal directly). No
// "danger"/"error" semantic color exists in this app's theme (only
// success/warning/info), so auth_failed/stale/degraded all read as
// warning-toned, distinguished by icon/label/copy instead of color.
const STATUS_STYLES: Record<HealthState, string> = {
  pending: 'bg-info/10 text-info',
  healthy: 'bg-success/10 text-success',
  degraded: 'bg-warning/10 text-warning',
  stale: 'bg-warning/10 text-warning',
  auth_failed: 'bg-warning/10 text-warning',
  closed: 'bg-surface-elevated text-text-tertiary',
};

const STATUS_LABELS: Record<HealthState, string> = {
  pending: 'Connecting',
  healthy: 'Connected',
  degraded: 'Reconnecting',
  stale: 'Data may be outdated',
  auth_failed: 'Needs reconnect',
  closed: 'Disconnected',
};

const STATUS_ICONS: Record<HealthState, typeof CheckCircle2> = {
  pending: Loader2,
  healthy: CheckCircle2,
  degraded: AlertCircle,
  stale: Clock,
  auth_failed: ShieldAlert,
  closed: CircleSlash,
};

const CLOSED_REASON_COPY: Record<string, string> = {
  user_removed: 'You disconnected this account.',
  provider_closed: 'The broker closed this account.',
  prop_breached: 'This challenge account was closed — this cannot be reconnected from VaultPoint.',
};

interface BrokerConnectionCardProps {
  connection: BrokerConnectionSummary;
  subscriptionTier: SubscriptionTier;
  onDisconnect: (id: string) => Promise<void>;
  onAuthorizeExecutionClick: (connection: BrokerConnectionSummary) => void;
  onManagedModeClick: (connection: BrokerConnectionSummary) => void;
  onDisableManagedMode: (id: string) => Promise<void>;
}

export function BrokerConnectionCard({
  connection,
  subscriptionTier,
  onDisconnect,
  onAuthorizeExecutionClick,
  onManagedModeClick,
  onDisableManagedMode,
}: BrokerConnectionCardProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isDisablingManagedMode, setIsDisablingManagedMode] = useState(false);

  async function handleDisableManagedMode() {
    if (
      !window.confirm(
        `Disable Managed Mode on ${connection.label}? Aria will stop placing trades automatically on this connection immediately.`
      )
    ) {
      return;
    }
    setIsDisablingManagedMode(true);
    await onDisableManagedMode(connection.id);
    setIsDisablingManagedMode(false);
  }

  async function handleDisconnect() {
    if (!window.confirm(`Disconnect ${connection.label}? VaultPoint will stop syncing this account.`)) {
      return;
    }
    setIsDisconnecting(true);
    await onDisconnect(connection.id);
    // No need to reset — the card unmounts once removed from the parent's list.
  }

  // health defaults to 'pending' defensively — every row this codebase
  // actually writes has it set (DB default, see the migration), but a
  // narrower Pick elsewhere or a stale cached prop shouldn't crash the
  // icon/label lookup.
  const health = connection.health ?? 'pending';
  const StatusIcon = STATUS_ICONS[health];
  // GET /api/brokers and the brokers page both exclude health='closed'
  // rows server-side, so this branch is defensive (a card that was
  // already rendered before a connection just closed, mid-session)
  // rather than a normally-reachable state.
  const isClosed = health === 'closed';

  return (
    <Card className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-text-primary">{connection.label}</p>
          <span className="text-xs text-text-tertiary">{BROKER_LABELS[connection.broker]}</span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              STATUS_STYLES[health]
            )}
          >
            <StatusIcon className={cn('h-3 w-3', health === 'pending' && 'animate-spin')} />
            {STATUS_LABELS[health]}
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

        {isClosed && connection.closed_reason && (
          <p className="mt-1.5 max-w-md text-xs text-text-tertiary">
            {CLOSED_REASON_COPY[connection.closed_reason] ?? 'This connection was closed.'}
          </p>
        )}

        {!isClosed && (health === 'degraded' || health === 'stale' || health === 'auth_failed') && connection.last_error && (
          <p className="mt-1.5 max-w-md text-xs text-warning">{connection.last_error}</p>
        )}

        {connection.trade_execution_enabled ? (
          <p className="mt-1.5 text-xs font-medium text-success">Authorized for Signal Mode execution</p>
        ) : (
          <button
            type="button"
            onClick={() => onAuthorizeExecutionClick(connection)}
            className="mt-1.5 text-xs font-medium text-accent-light hover:underline"
          >
            Authorize for trade execution
          </button>
        )}

        {/* Managed Mode is Elite-only and requires trade execution to
            already be authorized on this connection — matches the DB
            CHECK constraint (20260718000002_add_managed_mode.sql) and
            the API route's own tier check, not just a UI-side gate. */}
        {connection.trade_execution_enabled && subscriptionTier === 'elite' && (
          <div className="mt-1">
            {connection.managed_mode_enabled ? (
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-success">
                  Managed Mode active — risking {connection.managed_mode_risk_pct}% per trade, daily
                  loss limit {connection.managed_mode_daily_loss_limit_pct}%
                </p>
                <button
                  type="button"
                  onClick={handleDisableManagedMode}
                  disabled={isDisablingManagedMode}
                  className="text-xs font-medium text-warning hover:underline disabled:opacity-50"
                >
                  Disable
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onManagedModeClick(connection)}
                className="text-xs font-medium text-accent-light hover:underline"
              >
                Enable Managed Mode
              </button>
            )}
          </div>
        )}
      </div>

      {/* Nothing to disconnect once a connection is already closed —
          most visibly true for a prop_breached challenge account (spec
          D5: no further action is available from VaultPoint on one of
          these). */}
      {!isClosed && (
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={isDisconnecting}
          aria-label={`Disconnect ${connection.label}`}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </Card>
  );
}
