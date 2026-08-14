'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PROFIT_SHARE_PCT, type AttributedTrade } from '@/lib/billing/profit-share-shared';

interface Charge {
  id: string;
  period_start: string;
  period_end: string;
  attributed_profit: number;
  fee_amount: number;
  fee_currency: string;
  payment_provider: string | null;
  provider_charge_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
}

interface ProfitShareStatementProps {
  charge: Charge;
  trades: AttributedTrade[];
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ProfitShareStatement({ charge, trades }: ProfitShareStatementProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/dashboard/billing/profit-share" className="text-sm text-accent-light hover:underline">
          ← Back to billing
        </Link>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>

      <Card className="space-y-6 print:border-none print:shadow-none">
        <div className="flex items-start justify-between border-b border-border pb-4">
          <div>
            <p className="font-display text-lg font-semibold text-text-primary">VaultPoint</p>
            <p className="text-xs text-text-tertiary">Managed Mode Profit-Share Statement</p>
          </div>
          <p className="text-xs uppercase tracking-wide text-text-tertiary">{charge.status}</p>
        </div>

        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-text-tertiary">Period</span>
          <span className="text-right text-text-primary">
            {formatDate(charge.period_start)} – {formatDate(charge.period_end)}
          </span>
          <span className="text-text-tertiary">Billed</span>
          <span className="text-right text-text-primary">{formatDate(charge.created_at)}</span>
          {charge.payment_provider && (
            <>
              <span className="text-text-tertiary">Payment method</span>
              <span className="text-right capitalize text-text-primary">{charge.payment_provider}</span>
            </>
          )}
        </div>

        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex justify-between text-text-secondary">
            <span>Aria-attributed profit for period</span>
            <span>{formatCurrency(charge.attributed_profit)}</span>
          </div>
          <div className="flex justify-between text-text-secondary">
            <span>Profit-share rate</span>
            <span>{PROFIT_SHARE_PCT}%</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-text-primary">
            <span>Fee charged</span>
            <span>{formatCurrency(charge.fee_amount)}</span>
          </div>
        </div>

        {charge.status === 'failed' && charge.failure_reason && (
          <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            This charge did not go through: {charge.failure_reason}
          </div>
        )}

        <div className="border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
            Trades included ({trades.length})
          </p>
          {trades.length === 0 ? (
            <p className="text-sm text-text-tertiary">No Aria-attributed trades closed in this period.</p>
          ) : (
            <div className="space-y-1.5 text-sm">
              {trades.map((trade, i) => (
                <div key={i} className="flex items-center justify-between border-b border-border py-1.5 last:border-0">
                  <div>
                    <span className="font-medium text-text-primary">{trade.pair}</span>{' '}
                    <span className="text-xs uppercase text-text-tertiary">{trade.direction}</span>
                    <p className="text-xs text-text-tertiary">{formatDate(trade.closedAt)}</p>
                  </div>
                  <span className={trade.realizedPnl >= 0 ? 'text-success' : 'text-warning'}>
                    {trade.realizedPnl >= 0 ? '+' : ''}
                    {formatCurrency(trade.realizedPnl)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="border-t border-border pt-4 text-xs text-text-tertiary">
          This statement reflects VaultPoint&apos;s records for the stated period only and is not a tax document.
        </p>
      </Card>
    </div>
  );
}
