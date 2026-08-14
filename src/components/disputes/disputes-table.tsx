'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { computeSlaStatus } from '@/lib/validations/disputes';
import type { Dispute, DisputeCategory, DisputeStatus } from '@/types/database';

interface DisputesTableProps {
  disputes: Dispute[];
}

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 — Self-service',
  2: 'Tier 2 — Support',
  3: 'Tier 3 — Founder/Compliance',
  4: 'Tier 4 — Legal',
};

const STATUS_FILTERS: (DisputeStatus | 'all')[] = ['all', 'open', 'escalated', 'resolved', 'closed'];
const CATEGORY_FILTERS: (DisputeCategory | 'all')[] = ['all', 'fee', 'performance', 'recommendation', 'other'];

function SlaBadge({ dispute }: { dispute: Dispute }) {
  const sla = computeSlaStatus(dispute);
  if (!sla.ackDeadline && !sla.resolutionDeadline) {
    return <span className="text-xs text-text-tertiary">No SLA</span>;
  }
  if (sla.isBreached) {
    return (
      <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
        SLA breached
      </span>
    );
  }
  const deadline = sla.resolutionDeadline ?? sla.ackDeadline;
  return (
    <span className="text-xs text-text-tertiary">
      Due {deadline ? new Date(deadline).toLocaleDateString() : '—'}
    </span>
  );
}

export function DisputesTable({ disputes }: DisputesTableProps) {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('open');
  const [categoryFilter, setCategoryFilter] = useState<(typeof CATEGORY_FILTERS)[number]>('all');
  const [tierFilter, setTierFilter] = useState<number | 'all'>('all');

  const filtered = useMemo(() => {
    return disputes.filter((d) => {
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (tierFilter !== 'all' && d.tier !== tierFilter) return false;
      return true;
    });
  }, [disputes, statusFilter, categoryFilter, tierFilter]);

  const breachedCount = disputes.filter((d) => d.status === 'open' && computeSlaStatus(d).isBreached).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Disputes</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          {disputes.filter((d) => d.status === 'open').length} open · {breachedCount} SLA-breached
        </p>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-text-primary"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'All statuses' : s}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-text-primary"
        >
          {CATEGORY_FILTERS.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? 'All categories' : c}
            </option>
          ))}
        </select>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-text-primary"
        >
          <option value="all">All tiers</option>
          {[1, 2, 3, 4].map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {filtered.length} dispute{filtered.length === 1 ? '' : 's'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-sm text-text-tertiary">Nothing matches these filters.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((dispute) => (
                <Link
                  key={dispute.id}
                  href={`/dashboard/admin/disputes/${dispute.id}`}
                  className={cn(
                    'flex items-center justify-between rounded-lg border border-border p-3 text-sm hover:bg-surface-elevated',
                    dispute.status === 'open' && computeSlaStatus(dispute).isBreached && 'border-warning/40 bg-warning/5'
                  )}
                >
                  <div>
                    <span className="font-medium text-text-primary">{TIER_LABELS[dispute.tier]}</span>{' '}
                    <span className="capitalize text-text-tertiary">— {dispute.category}</span>
                    <p className="mt-0.5 text-xs text-text-tertiary">
                      Dispute {dispute.id.slice(0, 8)} · {dispute.reviewer} · opened{' '}
                      {new Date(dispute.opened_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs capitalize text-text-tertiary">{dispute.status}</span>
                    {dispute.status === 'open' && <SlaBadge dispute={dispute} />}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
