'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ManagedTier } from '@/types/database';

interface DistributionProp {
  id: string;
  period_start: string;
  period_end: string;
  gross_pnl: number;
  client_share: number;
  vaultpoint_share: number;
  payout_method: string | null;
  status: string;
  requested_at: string | null;
  confirmed_at: string | null;
  paid_at: string | null;
}

interface StatementViewProps {
  accountId: string;
  tier: ManagedTier;
  clientName: string | null;
  clientEmail: string;
  distribution: DistributionProp;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
}

export function StatementView({ accountId, tier, clientName, clientEmail, distribution }: StatementViewProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/dashboard/managed-accounts/${accountId}`} className="text-sm text-accent-light hover:underline">
          ← Back to account
        </Link>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>

      <Card className="space-y-6 print:border-none print:shadow-none">
        <div className="flex items-start justify-between border-b border-border pb-4">
          <div>
            <p className="font-display text-lg font-semibold text-text-primary">VaultPoint</p>
            <p className="text-xs text-text-tertiary capitalize">{tier} Managed Account Distribution Statement</p>
          </div>
          <p className="text-xs uppercase tracking-wide text-text-tertiary">{distribution.status}</p>
        </div>

        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-text-tertiary">Client</span>
          <span className="text-right text-text-primary">{clientName ?? clientEmail}</span>
          <span className="text-text-tertiary">Period</span>
          <span className="text-right text-text-primary">
            {formatDate(distribution.period_start)} – {formatDate(distribution.period_end)}
          </span>
          <span className="text-text-tertiary">Requested</span>
          <span className="text-right text-text-primary">{formatDate(distribution.requested_at)}</span>
          {distribution.paid_at && (
            <>
              <span className="text-text-tertiary">Paid</span>
              <span className="text-right text-text-primary">{formatDate(distribution.paid_at)}</span>
            </>
          )}
          <span className="text-text-tertiary">Payout destination</span>
          <span className="text-right text-text-primary">{distribution.payout_method ?? '—'}</span>
        </div>

        <div className="space-y-2 border-t border-border pt-4 text-sm">
          <div className="flex justify-between text-text-secondary">
            <span>Gross P&amp;L for period</span>
            <span>{formatCurrency(distribution.gross_pnl)}</span>
          </div>
          <div className="flex justify-between text-text-secondary">
            <span>VaultPoint&apos;s share</span>
            <span>{formatCurrency(distribution.vaultpoint_share)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-text-primary">
            <span>Net paid to client</span>
            <span>{formatCurrency(distribution.client_share)}</span>
          </div>
        </div>

        <p className="border-t border-border pt-4 text-xs text-text-tertiary">
          This statement reflects VaultPoint&apos;s records for the stated period only and is not a tax
          document. Status &quot;{distribution.status}&quot; indicates where this request stands in
          VaultPoint&apos;s manual review and payout process.
        </p>
      </Card>
    </div>
  );
}
