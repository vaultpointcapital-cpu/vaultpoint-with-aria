'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { ManagedAccountStats } from '@/lib/validations/managed-accounts';
import type { ManagedTradeSide } from '@/types/database';

interface AccountProp {
  id: string;
  tier: string;
  profit_split_pct: number;
  max_drawdown_pct: number;
  withdrawal_window_cadence: string;
  next_withdrawal_window_date: string | null;
  kyc_status: string;
  status: string;
  starting_capital: number | null;
  current_balance: number | null;
  requires_disclosure_reconfirmation: boolean;
  created_at: string;
}

interface TradeProp {
  symbol: string;
  side: ManagedTradeSide;
  size: number;
  entry_price: number;
  exit_price: number | null;
  realized_pnl: number | null;
  opened_at: string;
  closed_at: string | null;
}

interface AuthorizationProp {
  id: string;
  document_version: string;
  document_url: string;
  signed_at: string;
}

interface ManagedAccountDashboardProps {
  account: AccountProp;
  stats: ManagedAccountStats;
  trades: TradeProp[];
  authorization: AuthorizationProp | null;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function ManagedAccountDashboard({ account, stats, trades, authorization }: ManagedAccountDashboardProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold capitalize text-text-primary">
            {account.tier} Managed Account
          </h1>
          <p className="text-xs text-text-tertiary capitalize">{account.status.replace(/_/g, ' ')}</p>
        </div>
        {account.status === 'active' && (
          <Button asChild variant="outline">
            <Link href={`/dashboard/managed-accounts/${account.id}/withdraw`}>Request withdrawal</Link>
          </Button>
        )}
      </div>

      {account.requires_disclosure_reconfirmation && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Terms for your tier have changed. You must re-accept the updated disclosure before your next
          distribution.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <p className="text-xs text-text-tertiary">Current balance</p>
          <p className="mt-1 text-lg font-semibold text-text-primary">{formatCurrency(stats.currentBalance)}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-tertiary">All-time P&amp;L</p>
          <p
            className={cn(
              'mt-1 text-lg font-semibold',
              stats.allTimePnl >= 0 ? 'text-success' : 'text-warning'
            )}
          >
            {stats.allTimePnl >= 0 ? '+' : ''}
            {formatCurrency(stats.allTimePnl)}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-text-tertiary">P&amp;L since last distribution</p>
          <p
            className={cn(
              'mt-1 text-lg font-semibold',
              stats.pnlSinceLastDistribution >= 0 ? 'text-success' : 'text-warning'
            )}
          >
            {stats.pnlSinceLastDistribution >= 0 ? '+' : ''}
            {formatCurrency(stats.pnlSinceLastDistribution)}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-text-tertiary">Profit split</p>
          <p className="mt-1 text-lg font-semibold text-text-primary">{account.profit_split_pct}%</p>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Drawdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Current: {stats.drawdownPct.toFixed(1)}%</span>
            <span>Policy maximum: {account.max_drawdown_pct}%</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div
              className={cn(
                'h-full rounded-full',
                stats.drawdownPct / account.max_drawdown_pct >= 0.8 ? 'bg-warning' : 'bg-accent'
              )}
              style={{ width: `${Math.min(100, (stats.drawdownPct / account.max_drawdown_pct) * 100)}%` }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Next withdrawal window</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary capitalize">
            {account.withdrawal_window_cadence.replace(/_/g, ' ')} cadence
            {account.next_withdrawal_window_date
              ? ` — next window ${new Date(account.next_withdrawal_window_date).toLocaleDateString()}`
              : ''}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trade log</CardTitle>
        </CardHeader>
        <CardContent>
          {trades.length === 0 ? (
            <p className="text-sm text-text-tertiary">No trades yet.</p>
          ) : (
            <div className="space-y-2">
              {trades.map((trade, i) => (
                <div key={i} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
                  <div>
                    <span className="font-medium text-text-primary">{trade.symbol}</span>{' '}
                    <span className="text-xs uppercase text-text-tertiary">{trade.side}</span>
                  </div>
                  <div className="text-right">
                    {trade.realized_pnl !== null ? (
                      <span className={trade.realized_pnl >= 0 ? 'text-success' : 'text-warning'}>
                        {trade.realized_pnl >= 0 ? '+' : ''}
                        {formatCurrency(trade.realized_pnl)}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">Open</span>
                    )}
                    <p className="text-xs text-text-tertiary">
                      {trade.closed_at
                        ? formatDistanceToNow(new Date(trade.closed_at), { addSuffix: true })
                        : formatDistanceToNow(new Date(trade.opened_at), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {authorization && (
        <p className="text-xs text-text-tertiary">
          Signed authorization (v{authorization.document_version}) on{' '}
          {new Date(authorization.signed_at).toLocaleDateString()} —{' '}
          <a href={authorization.document_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            view document
          </a>
        </p>
      )}
    </div>
  );
}
