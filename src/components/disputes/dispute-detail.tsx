'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { computeSlaStatus } from '@/lib/validations/disputes';
import type { Dispute } from '@/types/database';

interface RelatedTrade {
  id: string;
  symbol: string;
  side: string;
  realized_pnl: number | null;
  opened_at: string;
  closed_at: string | null;
}

interface RelatedDistribution {
  id: string;
  period_start: string;
  period_end: string;
  client_share: number;
  status: string;
}

interface RelatedAuditEntry {
  id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
}

interface ValueLedgerEvent {
  id: string;
  event_name: string;
  properties: Record<string, unknown>;
  created_at: string;
}

interface DisputeDetailProps {
  dispute: Dispute;
  escalationChain: Dispute[];
  linkedEvents: ValueLedgerEvent[];
  relatedRecords: {
    trades: RelatedTrade[];
    distributions: RelatedDistribution[];
    auditLog: RelatedAuditEntry[];
  };
}

export function DisputeDetail({ dispute, escalationChain, linkedEvents, relatedRecords }: DisputeDetailProps) {
  const router = useRouter();
  const sla = computeSlaStatus(dispute);

  const [escalationReason, setEscalationReason] = useState('');
  const [resolutionSummary, setResolutionSummary] = useState('');
  const [resolutionAmount, setResolutionAmount] = useState('');
  const [resolveStatus, setResolveStatus] = useState<'resolved' | 'closed'>('resolved');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAct = dispute.status === 'open';

  async function handleEscalate() {
    setSubmitting(true);
    setActionError(null);
    const response = await fetch(`/api/admin/disputes/${dispute.id}/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escalationReason }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setActionError(body?.error ?? 'Could not escalate this dispute.');
      return;
    }
    router.refresh();
  }

  async function handleResolve() {
    setSubmitting(true);
    setActionError(null);
    const response = await fetch(`/api/admin/disputes/${dispute.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: resolveStatus,
        resolutionSummary,
        resolutionAmountNgn: resolutionAmount ? Number(resolutionAmount) : undefined,
      }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setActionError(body?.error ?? 'Could not resolve this dispute.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">
          Tier {dispute.tier} dispute — {dispute.category}
        </h1>
        <p className="mt-1 text-sm text-text-tertiary">
          {dispute.id} · opened {new Date(dispute.opened_at).toLocaleString()} · reviewer {dispute.reviewer}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            Status: <span className="capitalize">{dispute.status}</span>
          </p>
          {sla.ackDeadline && (
            <p>
              Acknowledgment due: {sla.ackDeadline.toLocaleString()}{' '}
              {sla.ackBreached && <span className="text-warning">(breached)</span>}
            </p>
          )}
          {sla.resolutionDeadline && (
            <p>
              Resolution due: {sla.resolutionDeadline.toLocaleString()}{' '}
              {sla.resolutionBreached && <span className="text-warning">(breached)</span>}
            </p>
          )}
          <p className="pt-2 text-text-tertiary">{dispute.escalation_reason}</p>
        </CardContent>
      </Card>

      {escalationChain.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Escalation history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {escalationChain.map((row) => (
              <p key={row.id} className={row.id === dispute.id ? 'font-medium text-text-primary' : 'text-text-tertiary'}>
                Tier {row.tier} — {row.status} — opened {new Date(row.opened_at).toLocaleDateString()}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Linked Value Ledger events ({linkedEvents.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {linkedEvents.length === 0 ? (
            <p className="text-text-tertiary">
              No linked events — the Value Ledger event trail does not yet instrument managed-account fee/return
              events (see this feature&apos;s migration header). This is a known gap, not a bug in this view.
            </p>
          ) : (
            linkedEvents.map((event) => (
              <p key={event.id} className="text-text-tertiary">
                {event.event_name} — {new Date(event.created_at).toLocaleString()}
              </p>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Related account records</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {relatedRecords.trades.length > 0 && (
            <div>
              <p className="font-medium text-text-primary">Trades</p>
              {relatedRecords.trades.map((t) => (
                <p key={t.id} className="text-text-tertiary">
                  {t.symbol} {t.side} — P&amp;L {t.realized_pnl ?? 'open'} — {new Date(t.opened_at).toLocaleDateString()}
                </p>
              ))}
            </div>
          )}
          {relatedRecords.distributions.length > 0 && (
            <div>
              <p className="font-medium text-text-primary">Profit distributions</p>
              {relatedRecords.distributions.map((d) => (
                <p key={d.id} className="text-text-tertiary">
                  {d.period_start} – {d.period_end}: {d.client_share} ({d.status})
                </p>
              ))}
            </div>
          )}
          {relatedRecords.auditLog.length > 0 && (
            <div>
              <p className="font-medium text-text-primary">Audit log</p>
              {relatedRecords.auditLog.map((entry) => (
                <p key={entry.id} className="text-text-tertiary">
                  {entry.event_type} — {new Date(entry.created_at).toLocaleString()}
                </p>
              ))}
            </div>
          )}
          {relatedRecords.trades.length === 0 && relatedRecords.distributions.length === 0 && relatedRecords.auditLog.length === 0 && (
            <p className="text-text-tertiary">No linked managed account, or no records for it yet.</p>
          )}
        </CardContent>
      </Card>

      {canAct && (
        <>
          {dispute.tier < 4 && (
            <Card>
              <CardHeader>
                <CardTitle>Escalate to Tier {dispute.tier + 1}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  value={escalationReason}
                  onChange={(e) => setEscalationReason(e.target.value)}
                  placeholder="Why is this escalating?"
                  className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
                  rows={3}
                />
                <Button
                  variant="outline"
                  isLoading={submitting}
                  disabled={!escalationReason.trim()}
                  onClick={handleEscalate}
                >
                  Escalate
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Resolve</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <select
                value={resolveStatus}
                onChange={(e) => setResolveStatus(e.target.value as 'resolved' | 'closed')}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-text-primary"
              >
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <textarea
                value={resolutionSummary}
                onChange={(e) => setResolutionSummary(e.target.value)}
                placeholder="Resolution summary — the record SEC Nigeria (or a compliance hire) would need"
                className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
                rows={3}
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={resolutionAmount}
                onChange={(e) => setResolutionAmount(e.target.value)}
                placeholder="Refund/adjustment amount (₦, optional)"
                className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
              />
              <Button isLoading={submitting} disabled={!resolutionSummary.trim()} onClick={handleResolve}>
                Resolve
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {actionError && <p className="text-sm text-warning">{actionError}</p>}
    </div>
  );
}
