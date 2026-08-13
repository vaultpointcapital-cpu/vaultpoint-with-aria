'use client';

import { useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { ValueLedgerRollup } from '@/types/database';

interface RollupRow extends ValueLedgerRollup {
  users: { full_name: string | null; academy_student: boolean } | null;
}

interface FunnelEntry {
  transition: string;
  count: number;
}

interface ValueLedgerDashboardProps {
  rows: RollupRow[];
  rollupDate: string | null;
  funnel: FunnelEntry[];
}

type SortKey = 'value_score' | 'value_to_price_ratio' | 'churn_risk_score';

const CHURN_LEVEL_STYLES: Record<string, string> = {
  low: 'border-border text-text-tertiary',
  medium: 'border-warning/40 bg-warning/10 text-warning',
  high: 'border-warning/60 bg-warning/20 text-warning',
};

function formatRatio(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

export function ValueLedgerDashboard({ rows, rollupDate, funnel }: ValueLedgerDashboardProps) {
  const [sortKey, setSortKey] = useState<SortKey>('churn_risk_score');
  const [sortDesc, setSortDesc] = useState(true);
  const [tierFilter, setTierFilter] = useState<string>('all');

  const filtered = useMemo(
    () => (tierFilter === 'all' ? rows : rows.filter((r) => r.subscription_tier === tierFilter)),
    [rows, tierFilter]
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortDesc ? bv - av : av - bv;
    });
    return copy;
  }, [filtered, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const upsellCandidates = rows.filter((r) => r.upsell_candidate);
  const highChurnRisk = rows.filter((r) => r.churn_risk_level === 'high');

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Value Ledger</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          {rollupDate ? `Latest rollup: ${new Date(rollupDate).toLocaleDateString()}` : 'No rollup has run yet.'} ·{' '}
          {rows.length} users · {highChurnRisk.length} high churn risk · {upsellCandidates.length} upsell candidates
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tier conversions (90d)</CardTitle>
          <CardDescription>From value_ledger_events (event_name=&apos;tier_changed&apos;)</CardDescription>
        </CardHeader>
        <CardContent>
          {funnel.length === 0 ? (
            <p className="text-sm text-text-tertiary">No tier changes recorded in this window.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {funnel.map((entry) => (
                <span
                  key={entry.transition}
                  className="rounded-full border border-border px-3 py-1 text-xs text-text-secondary"
                >
                  {entry.transition}: <span className="font-mono-num text-text-primary">{entry.count}</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Per-user scores</CardTitle>
            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-text-primary"
            >
              <option value="all">All tiers</option>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="elite">Elite</option>
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {sorted.length === 0 ? (
            <p className="text-sm text-text-tertiary">No rollup rows for this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-tertiary">
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Tier</th>
                    <SortableHeader label="Value score" active={sortKey === 'value_score'} desc={sortDesc} onClick={() => toggleSort('value_score')} />
                    <SortableHeader
                      label="Value/price"
                      active={sortKey === 'value_to_price_ratio'}
                      desc={sortDesc}
                      onClick={() => toggleSort('value_to_price_ratio')}
                    />
                    <SortableHeader
                      label="Churn risk"
                      active={sortKey === 'churn_risk_score'}
                      desc={sortDesc}
                      onClick={() => toggleSort('churn_risk_score')}
                    />
                    <th className="py-2 pr-3 font-medium">Reasons</th>
                    <th className="py-2 font-medium">Upsell</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-3 text-text-primary">
                        {row.users?.full_name ?? row.user_id.slice(0, 8)}
                        {row.users?.academy_student && (
                          <span className="ml-1 text-xs text-text-tertiary">(academy)</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 capitalize text-text-secondary">{row.subscription_tier}</td>
                      <td className="py-2 pr-3 font-mono-num text-text-primary">{row.value_score.toFixed(1)}</td>
                      <td className="py-2 pr-3 font-mono-num text-text-primary">{formatRatio(row.value_to_price_ratio)}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-xs',
                            CHURN_LEVEL_STYLES[row.churn_risk_level]
                          )}
                        >
                          {row.churn_risk_score.toFixed(0)} · {row.churn_risk_level}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-text-tertiary">
                        {row.churn_risk_reasons.length > 0 ? row.churn_risk_reasons.join(', ') : '—'}
                      </td>
                      <td className="py-2 text-xs">{row.upsell_candidate ? '✓' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortableHeader({
  label,
  active,
  desc,
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <th className="py-2 pr-3 font-medium">
      <button
        type="button"
        onClick={onClick}
        className={cn('flex items-center gap-1 hover:text-text-primary', active ? 'text-text-primary' : '')}
      >
        {label}
        {active && <span>{desc ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
}
