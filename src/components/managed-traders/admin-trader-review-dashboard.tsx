'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { KycVerificationState } from '@/types/database';

interface TraderRow {
  trader: {
    id: string;
    user_id: string;
    status: 'pending' | 'approved' | 'rejected' | 'suspended';
    proposed_profit_split: number;
    approved_profit_split: number | null;
    max_clients: number | null;
    academy_modules_confirmed: boolean;
    strategy_description: string | null;
    has_managed_funds_before: boolean | null;
    has_managed_funds_before_explanation: string | null;
    understands_trade_only_confirmed_at: string | null;
    agrees_to_audit_logging_confirmed_at: string | null;
    reviewer_notes: string | null;
    created_at: string;
    reviewed_at: string | null;
  };
  applicantName: string | null;
  kycState: KycVerificationState;
  kycVendor: string | null;
}

interface AdminTraderReviewDashboardProps {
  rows: TraderRow[];
}

export function AdminTraderReviewDashboard({ rows }: AdminTraderReviewDashboardProps) {
  const pending = rows.filter((r) => r.trader.status === 'pending');
  const decided = rows.filter((r) => r.trader.status !== 'pending');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Managed Trader Applications</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {pending.length} pending review. Every checklist item must be satisfied before an application can be
          approved — no partial approvals.
        </p>
      </div>

      {pending.length === 0 && (
        <Card className="p-6 text-center text-sm text-text-secondary">No applications awaiting review.</Card>
      )}

      {pending.map((row) => (
        <PendingApplicationCard key={row.trader.id} row={row} />
      ))}

      {decided.length > 0 && (
        <div className="space-y-3 pt-4">
          <h2 className="font-display text-base font-semibold text-text-primary">Previously Reviewed</h2>
          {decided.map((row) => (
            <Card key={row.trader.id} className="flex items-center justify-between p-4 text-sm">
              <div>
                <p className="text-text-primary">{row.applicantName ?? row.trader.user_id}</p>
                <p className="text-text-tertiary">
                  {row.trader.reviewed_at ? new Date(row.trader.reviewed_at).toLocaleDateString() : '—'}
                </p>
              </div>
              <span
                className={cn(
                  'font-medium',
                  row.trader.status === 'approved' && 'text-success',
                  row.trader.status === 'rejected' && 'text-warning'
                )}
              >
                {row.trader.status}
              </span>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PendingApplicationCard({ row }: { row: TraderRow }) {
  const router = useRouter();
  const [approvedProfitSplit, setApprovedProfitSplit] = useState(String(row.trader.proposed_profit_split));
  const [maxClients, setMaxClients] = useState(row.trader.max_clients ? String(row.trader.max_clients) : '');
  const [reviewerNotes, setReviewerNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kycVerified = row.kycState === 'verified';
  const academyConfirmed = row.trader.academy_modules_confirmed;
  const checklistComplete = kycVerified && academyConfirmed;

  async function submitReview(status: 'approved' | 'rejected') {
    setError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/admin/managed-traders/${row.trader.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        approved_profit_split: status === 'approved' ? Number(approvedProfitSplit) : undefined,
        max_clients: maxClients ? Number(maxClients) : undefined,
        reviewer_notes: reviewerNotes || undefined,
      }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? 'Could not save the review decision.');
      return;
    }

    router.refresh();
  }

  return (
    <Card className="space-y-4 p-6">
      <CardHeader className="p-0">
        <CardTitle>{row.applicantName ?? row.trader.user_id}</CardTitle>
        <CardDescription>Applied {new Date(row.trader.created_at).toLocaleDateString()}</CardDescription>
      </CardHeader>

      {error && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
          {error}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-background p-4 text-sm">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
          Section E — Review Checklist
        </p>
        <ChecklistItem label="KYC verified" checked={kycVerified} detail={row.kycVendor ? `via ${row.kycVendor} (${row.kycState})` : row.kycState} />
        <ChecklistItem label="Required Academy modules confirmed" checked={academyConfirmed} />
        <ChecklistItem
          label="Track record meets minimum threshold"
          checked={null}
          detail="No threshold set by compliance yet (PRD Open Question #3) — reviewer judgment required."
        />
        <ChecklistItem
          label="No red flags in Section A.5 (sanctions)"
          checked={null}
          detail="Not auto-determined — check the KYC result summary."
        />
      </div>

      <div className="space-y-2 text-sm">
        <p className="text-text-secondary">
          <span className="font-medium text-text-primary">Strategy: </span>
          {row.trader.strategy_description ?? '—'}
        </p>
        <p className="text-text-secondary">
          <span className="font-medium text-text-primary">Managed funds before: </span>
          {row.trader.has_managed_funds_before ? row.trader.has_managed_funds_before_explanation ?? 'Yes' : 'No'}
        </p>
        <p className="text-text-secondary">
          <span className="font-medium text-text-primary">Proposed split: </span>
          {row.trader.proposed_profit_split}% · <span className="font-medium text-text-primary">Requested clients: </span>
          {row.trader.max_clients ?? '—'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`approved-split-${row.trader.id}`}>Approved profit split (%)</Label>
          <Input
            id={`approved-split-${row.trader.id}`}
            type="number"
            min="0"
            max="100"
            value={approvedProfitSplit}
            onChange={(e) => setApprovedProfitSplit(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`max-clients-${row.trader.id}`}>Max clients (override)</Label>
          <Input
            id={`max-clients-${row.trader.id}`}
            type="number"
            min="1"
            value={maxClients}
            onChange={(e) => setMaxClients(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`notes-${row.trader.id}`}>Reviewer notes</Label>
        <Textarea
          id={`notes-${row.trader.id}`}
          value={reviewerNotes}
          onChange={(e) => setReviewerNotes(e.target.value)}
          maxLength={2000}
        />
      </div>

      <div className="flex gap-3">
        <Button
          type="button"
          className="flex-1"
          isLoading={isSubmitting}
          disabled={isSubmitting || !checklistComplete}
          onClick={() => submitReview('approved')}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="flex-1"
          isLoading={isSubmitting}
          disabled={isSubmitting}
          onClick={() => submitReview('rejected')}
        >
          Reject
        </Button>
      </div>
      {!checklistComplete && (
        <p className="text-xs text-text-tertiary">Approve is disabled until KYC is verified and Academy modules are confirmed.</p>
      )}
    </Card>
  );
}

function ChecklistItem({ label, checked, detail }: { label: string; checked: boolean | null; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-text-secondary">{label}</span>
      <span
        className={cn(
          'shrink-0 font-medium',
          checked === true && 'text-success',
          checked === false && 'text-warning',
          checked === null && 'text-text-tertiary'
        )}
      >
        {checked === true ? '✓' : checked === false ? '✗' : '—'}
        {detail ? ` ${detail}` : ''}
      </span>
    </div>
  );
}
