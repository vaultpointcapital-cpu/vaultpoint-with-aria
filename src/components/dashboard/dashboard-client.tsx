'use client';

import Link from 'next/link';
import { Link2, Target, TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NetWorthChart } from '@/components/dashboard/net-worth-chart';
import { DailyVideoCard } from '@/components/dashboard/daily-video-card';
import { OfferCard, type OfferCardData } from '@/components/offers/offer-card';
import { formatCurrency, formatPercentage } from '@/lib/utils/cn';
import { calculatePositionPnl, calculatePositionPnlPct, calculatePodProgress } from '@/lib/utils/financial';
import type { Position, SavingsPod, PortfolioSnapshot, AcademyVideo } from '@/types/database';

type PositionWithAccountType = Position & { broker_connections: { account_type: string } | null };

interface DashboardClientProps {
  initialNetWorth: number;
  initialPnl: number;
  initialPositions: PositionWithAccountType[];
  initialPods: SavingsPod[];
  initialSnapshots: PortfolioSnapshot[];
  dailyVideo: AcademyVideo | null;
  hasConnectedBroker: boolean;
  offers: OfferCardData[];
}

export function DashboardClient({
  initialNetWorth,
  initialPnl,
  initialPositions,
  initialPods,
  initialSnapshots,
  dailyVideo,
  hasConnectedBroker,
  offers,
}: DashboardClientProps) {
  if (!hasConnectedBroker && initialPositions.length === 0) {
    return <EmptyDashboardState dailyVideo={dailyVideo} offers={offers} />;
  }

  // Simulated-capital positions (Partner Offers v1) are rendered in their
  // own "Funded accounts" section below, never mixed into the regular
  // Open Positions stat/list — that list's dollar figures must only ever
  // reflect the user's own money, same rule as net worth.
  const livePositions = initialPositions.filter((p) => p.broker_connections?.account_type !== 'simulated');
  const simulatedPositions = initialPositions.filter((p) => p.broker_connections?.account_type === 'simulated');

  const isPnlPositive = initialPnl >= 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      {/* Hero net worth card */}
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-10 -top-16 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Total Portfolio Value
        </p>
        <p className="mt-1 font-display text-4xl font-bold tracking-tight text-text-primary">
          {formatCurrency(initialNetWorth)}
        </p>
        <div className="mt-3 flex items-center gap-2 font-mono-num text-sm">
          {isPnlPositive ? (
            <TrendingUp className="h-4 w-4 text-success" />
          ) : (
            <TrendingDown className="h-4 w-4 text-warning" />
          )}
          <span className={isPnlPositive ? 'text-success' : 'text-warning'}>
            {formatCurrency(initialPnl)} unrealized
          </span>
        </div>
      </Card>

      <DailyVideoCard video={dailyVideo} />

      <NetWorthChart snapshots={initialSnapshots} />

      {/* Stat row */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            Open Positions
          </p>
          <p className="mt-1 font-display text-xl font-semibold text-text-primary">
            {livePositions.length}
          </p>
        </Card>
        <Card>
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            Unrealized P&amp;L
          </p>
          <p
            className={`mt-1 font-display text-xl font-semibold ${
              isPnlPositive ? 'text-success' : 'text-warning'
            }`}
          >
            {formatCurrency(initialPnl)}
          </p>
        </Card>
        <Card>
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            Savings Pods
          </p>
          <p className="mt-1 font-display text-xl font-semibold text-text-primary">
            {initialPods.length}
          </p>
        </Card>
      </div>

      {/* Positions list */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Open Positions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {livePositions.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-tertiary">
              No open positions yet. They&apos;ll appear here once your broker syncs.
            </p>
          ) : (
            livePositions.map((position) => {
              const pnl =
                position.mark_price !== null
                  ? calculatePositionPnl({
                      side: position.side,
                      size: position.size,
                      entry_price: position.entry_price,
                      mark_price: position.mark_price,
                    })
                  : null;
              const pnlPct =
                position.mark_price !== null
                  ? calculatePositionPnlPct({
                      side: position.side,
                      size: position.size,
                      entry_price: position.entry_price,
                      mark_price: position.mark_price,
                    })
                  : null;
              const positive = (pnl ?? 0) >= 0;

              return (
                <div
                  key={position.id}
                  className="flex items-center justify-between border-b border-border py-3 last:border-none"
                >
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{position.symbol}</p>
                    <p className="text-xs text-text-tertiary">
                      {position.side.toUpperCase()} · {position.size}
                    </p>
                  </div>
                  <div className="text-right font-mono-num text-sm">
                    {pnl !== null ? (
                      <>
                        <p className={positive ? 'text-success' : 'text-warning'}>
                          {formatCurrency(pnl)}
                        </p>
                        <p className={`text-xs ${positive ? 'text-success' : 'text-warning'}`}>
                          {formatPercentage(pnlPct ?? 0)}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-text-tertiary">Awaiting sync...</p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Funded accounts — simulated-capital connections (Partner Offers v1).
          Never shown alongside real dollar P&L: challenge progress only. */}
      {simulatedPositions.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <CardTitle>Funded accounts</CardTitle>
            <Badge>Simulated capital</Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="mb-2 text-xs text-text-tertiary">
              Not your own funds — excluded from your net worth above.
            </p>
            {simulatedPositions.map((position) => {
              const progress =
                position.mark_price !== null
                  ? calculatePositionPnl({
                      side: position.side,
                      size: position.size,
                      entry_price: position.entry_price,
                      mark_price: position.mark_price,
                    })
                  : null;

              return (
                <div
                  key={position.id}
                  className="flex items-center justify-between border-b border-border py-3 last:border-none"
                >
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{position.symbol}</p>
                    <p className="text-xs text-text-tertiary">
                      {position.side.toUpperCase()} · {position.size}
                    </p>
                  </div>
                  <div className="text-right font-mono-num text-sm">
                    {progress !== null ? (
                      <>
                        <p className="text-text-primary">{formatCurrency(progress)}</p>
                        <p className="text-xs text-text-tertiary">challenge progress</p>
                      </>
                    ) : (
                      <p className="text-xs text-text-tertiary">Awaiting sync...</p>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Savings pods */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Savings Pods</CardTitle>
          <Link href="/dashboard/pods" className="text-xs font-medium text-accent-light hover:underline">
            Manage →
          </Link>
        </CardHeader>
        <CardContent>
          {initialPods.length === 0 ? (
            <Link
              href="/dashboard/pods/new"
              className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-center transition-colors hover:border-accent"
            >
              <Target className="h-6 w-6 text-accent" />
              <span className="text-sm text-text-secondary">Start your first Savings Pod</span>
            </Link>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {initialPods.map((pod) => {
                const progress = calculatePodProgress(pod.current_amount, pod.target_amount);
                return (
                  <div key={pod.id} className="rounded-lg border border-border bg-surface-elevated p-4">
                    <p className="mb-3 text-sm font-semibold text-text-primary">{pod.name}</p>
                    <div className="h-1.5 w-full rounded-full bg-border">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${progress}%`, backgroundColor: pod.color }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between font-mono-num text-xs text-text-secondary">
                      <span>{formatCurrency(pod.current_amount)}</span>
                      <span>{formatCurrency(pod.target_amount)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyDashboardState({ dailyVideo, offers }: { dailyVideo: AcademyVideo | null; offers: OfferCardData[] }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
        <Link2 className="h-7 w-7 text-accent" />
      </div>
      <div>
        <h2 className="font-display text-xl font-semibold text-text-primary">
          Connect your first broker
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
          Link a read-only API key from Bybit, Binance, KuCoin, or MetaTrader to see your
          live portfolio here.
        </p>
      </div>
      <Button asChild>
        <Link href="/dashboard/brokers/add">Connect a broker</Link>
      </Button>

      {offers.length > 0 && (
        <div className="w-full max-w-sm text-left">
          {offers.map((offer) => (
            <OfferCard key={offer.id} offer={offer} />
          ))}
        </div>
      )}

      {dailyVideo && (
        <div className="w-full max-w-xs">
          <DailyVideoCard video={dailyVideo} />
        </div>
      )}
    </div>
  );
}
