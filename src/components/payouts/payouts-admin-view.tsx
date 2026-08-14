'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { PayoutLedgerEntry, WithdrawalEvent } from '@/types/database';

interface PayoutsAdminViewProps {
  events: WithdrawalEvent[];
  ledgerEntries: PayoutLedgerEntry[];
}

export function PayoutsAdminView({ events, ledgerEntries }: PayoutsAdminViewProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const pendingReview = events.filter((e) => e.status === 'pending');

  async function runAction(id: string, path: string, body?: unknown) {
    setBusyId(id);
    setError(null);
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusyId(null);
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null);
      setError(responseBody?.error ?? 'Action failed.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Payouts</h1>
        <p className="mt-1 text-sm text-text-tertiary">{pendingReview.length} withdrawal event(s) awaiting review.</p>
      </div>

      {error && <p className="text-sm text-warning">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Review queue</CardTitle>
        </CardHeader>
        <CardContent>
          {pendingReview.length === 0 ? (
            <p className="text-sm text-text-tertiary">Nothing pending review.</p>
          ) : (
            <div className="space-y-3">
              {pendingReview.map((event) => (
                <div
                  key={event.id}
                  className={cn(
                    'rounded-lg border p-3 text-sm',
                    event.confidence === 'auto_detected' ? 'border-border' : 'border-warning/40 bg-warning/5'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">
                      Detected {event.detected_amount} — {event.confidence.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-text-tertiary">{new Date(event.detected_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    Connection {event.broker_connection_id.slice(0, 8)} · balance {event.balance_before} →{' '}
                    {event.balance_after}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      isLoading={busyId === event.id}
                      onClick={() => runAction(event.id, `/api/admin/withdrawal-events/${event.id}/confirm`)}
                    >
                      Confirm — real withdrawal
                    </Button>
                    <input
                      type="text"
                      placeholder="Rejection reason"
                      value={rejectReason[event.id] ?? ''}
                      onChange={(e) => setRejectReason((prev) => ({ ...prev, [event.id]: e.target.value }))}
                      className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      isLoading={busyId === event.id}
                      disabled={!rejectReason[event.id]?.trim()}
                      onClick={() =>
                        runAction(event.id, `/api/admin/withdrawal-events/${event.id}/reject`, {
                          reason: rejectReason[event.id],
                        })
                      }
                    >
                      Reject — not a withdrawal
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payout ledger ({ledgerEntries.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {ledgerEntries.length === 0 ? (
            <p className="text-sm text-text-tertiary">No calculated payouts yet.</p>
          ) : (
            <div className="space-y-2">
              {ledgerEntries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">
                      Trader {entry.trader_amount} / VaultPoint {entry.vaultpoint_amount}
                    </span>
                    <span className="text-xs capitalize text-text-tertiary">{entry.status.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {entry.collection_method.replace(/_/g, ' ')} · split {entry.split_direction.replace(/_/g, ' ')}
                    {entry.trader_marked_executed_at && ' · trader marked executed'}
                  </p>
                  {entry.status !== 'collected' && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {entry.collection_method === 'crypto_two_step' && entry.status === 'pending_trader_execution' && (
                        <Button
                          size="sm"
                          variant="outline"
                          isLoading={busyId === entry.id}
                          onClick={() => runAction(entry.id, `/api/admin/payout-ledger/${entry.id}/mark-trader-executed`)}
                        >
                          Trader confirmed sent
                        </Button>
                      )}
                      {entry.collection_method === 'fiat_card_charge' && entry.status === 'pending' && (
                        <Button
                          size="sm"
                          isLoading={busyId === entry.id}
                          onClick={() => runAction(entry.id, `/api/admin/payout-ledger/${entry.id}/charge-fiat`)}
                        >
                          Charge card on file
                        </Button>
                      )}
                      <Button
                        size="sm"
                        isLoading={busyId === entry.id}
                        onClick={() => runAction(entry.id, `/api/admin/payout-ledger/${entry.id}/confirm-collected`)}
                      >
                        Confirm collected (on-chain verified)
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
