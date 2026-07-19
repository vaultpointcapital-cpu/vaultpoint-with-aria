'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { AttributedTrade } from '@/lib/billing/profit-share-shared';

interface CurrentPeriod {
  periodStart: string;
  periodEnd: string;
  attributedProfit: number;
  projectedFee: number;
  feePct: number;
  trades: AttributedTrade[];
}

interface HistoryCharge {
  id: string;
  period_start: string;
  period_end: string;
  attributed_profit: number;
  fee_amount: number;
  fee_currency: string;
  payment_provider: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
}

interface ProfitShareDashboardProps {
  currentPeriod: CurrentPeriod;
  history: HistoryCharge[];
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

const STATUS_LABELS: Record<string, string> = {
  charged: 'Charged',
  skipped: 'No charge (loss/breakeven period)',
  failed: 'Payment failed',
  pending: 'Pending',
};

const STATUS_CLASSES: Record<string, string> = {
  charged: 'bg-success/10 text-success border-success/30',
  skipped: 'bg-surface-elevated text-text-tertiary border-border',
  failed: 'bg-warning/10 text-warning border-warning/30',
  pending: 'bg-info/10 text-info border-info/30',
};

export function ProfitShareDashboard({ currentPeriod, history }: ProfitShareDashboardProps) {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);

  async function handleRefresh() {
    setIsRefreshing(true);
    router.refresh();
    // router.refresh() re-runs the server component; this just gives the
    // button a brief visible loading state rather than appearing to do
    // nothing while that request is in flight.
    setTimeout(() => setIsRefreshing(false), 600);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold text-text-primary">Profit-share billing</h1>
          <p className="mt-1 text-sm text-text-tertiary">
            {currentPeriod.feePct}% of profit Aria realizes autonomously under Managed Mode. Manual Signal Mode
            trades and trades you place yourself are never included.
          </p>
        </div>
        <Button variant="outline" size="sm" isLoading={isRefreshing} onClick={handleRefresh}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>This period so far</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="status"
            className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm text-info"
          >
            Not a charge — {formatDate(currentPeriod.periodStart)} through today is still in progress. VaultPoint
            only bills a completed calendar month, and only once, after it ends.
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-text-secondary">
              <span>Aria-attributed profit so far</span>
              <span className={currentPeriod.attributedProfit >= 0 ? 'text-success' : 'text-warning'}>
                {currentPeriod.attributedProfit >= 0 ? '+' : ''}
                {formatCurrency(currentPeriod.attributedProfit)}
              </span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold text-text-primary">
              <span>Projected fee if this period ended today ({currentPeriod.feePct}%)</span>
              <span>{formatCurrency(currentPeriod.projectedFee)}</span>
            </div>
          </div>

          {currentPeriod.trades.length > 0 && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Trades counted so far ({currentPeriod.trades.length})
              </p>
              <div className="space-y-1.5">
                {currentPeriod.trades.map((trade, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">
                      <span className="font-medium text-text-primary">{trade.pair}</span>{' '}
                      <span className="text-xs uppercase text-text-tertiary">{trade.direction}</span>
                    </span>
                    <span className={trade.realizedPnl >= 0 ? 'text-success' : 'text-warning'}>
                      {trade.realizedPnl >= 0 ? '+' : ''}
                      {formatCurrency(trade.realizedPnl)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Statement history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-text-tertiary">No completed billing periods yet.</p>
          ) : (
            <div className="space-y-2">
              {history.map((charge) => (
                <Link
                  key={charge.id}
                  href={`/dashboard/billing/profit-share/${charge.id}`}
                  className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0 hover:text-accent"
                >
                  <div>
                    <span className="font-medium text-text-primary">
                      {formatDate(charge.period_start)} – {formatDate(charge.period_end)}
                    </span>
                    <p className="mt-0.5">
                      <span
                        className={cn(
                          'inline-block rounded-full border px-2 py-0.5 text-xs',
                          STATUS_CLASSES[charge.status] ?? STATUS_CLASSES.pending
                        )}
                      >
                        {STATUS_LABELS[charge.status] ?? charge.status}
                      </span>
                    </p>
                  </div>
                  <span className="text-text-secondary">{formatCurrency(charge.fee_amount)}</span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
