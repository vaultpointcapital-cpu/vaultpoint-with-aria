'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Link2, Target, TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NetWorthChart } from '@/components/dashboard/net-worth-chart';
import { DailyVideoCard } from '@/components/dashboard/daily-video-card';
import { OfferCard, type OfferCardData } from '@/components/offers/offer-card';
import { WalletCard } from '@/components/dashboard/wallet-card';
import { formatMoneyJSON, formatPercentage } from '@/lib/utils/cn';
import type { MoneyJSON } from '@/lib/money';
import type { PortfolioSnapshot, AcademyVideo, KycTier, KycTierLimits, Wallet, WalletTxnType, WalletTxnStatus } from '@/types/database';
import type { WalletProvider } from '@/lib/wallet/routing';

/**
 * Money & Currency Layer: decimal.js/Money only ever runs server-side —
 * this 'use client' component never imports financial.ts or Money, only
 * receives already-computed MoneyJSON/plain-number props from
 * dashboard/page.tsx and renders them with formatMoneyJSON (dependency-free).
 */
export interface DisplayPosition {
  id: string;
  symbol: string;
  side: string;
  size: number;
  unrealizedPnl: MoneyJSON | null;
  unrealizedPnlPct: number | null;
}

export interface DisplayPod {
  id: string;
  name: string;
  color: string;
  currentAmount: MoneyJSON;
  targetAmount: MoneyJSON;
  progressPct: number;
}

/** Valuation Contract — one row per simulated broker connection
 * (PropAccountProvider's Holding), not per position. `value` is null only
 * if that connection's currency had no obtainable FX rate for display. */
export interface DisplayFundedAccount {
  id: string;
  label: string;
  value: MoneyJSON | null;
}

/** Dashboard Wallet Card data — see wallet-card.tsx. Computed server-side
 * in dashboard/page.tsx (Money & Currency Layer: this client component
 * only ever receives already-computed MoneyJSON, same as every other
 * prop here). */
export interface DashboardWallet {
  error: boolean;
  currency: string;
  balance: MoneyJSON | null;
  pendingAmount: MoneyJSON | null;
  hasAnyWallet: boolean;
  wallets: Pick<Wallet, 'currency' | 'balance_cached' | 'updated_at'>[];
  lastTransaction: { type: WalletTxnType; amount: MoneyJSON; status: WalletTxnStatus } | null;
  lastUsedRail: { currency: string; provider: WalletProvider };
  kycTier: KycTier;
  kycLimits: KycTierLimits | null;
}

interface DashboardClientProps {
  initialNetWorth: MoneyJSON;
  initialPnl: MoneyJSON;
  livePositions: DisplayPosition[];
  fundedAccounts: DisplayFundedAccount[];
  totalPositionCount: number;
  unpricedHoldings: string[];
  initialPods: DisplayPod[];
  initialSnapshots: PortfolioSnapshot[];
  dailyVideo: AcademyVideo | null;
  hasConnectedBroker: boolean;
  offers: OfferCardData[];
  wallet: DashboardWallet;
}

/**
 * Handles the return trip from a Paystack deposit redirect
 * (deposit/initiate/route.ts's callbackUrl -> /dashboard?deposit=success).
 * Deliberately does NOT use the spec's confirmed-success copy ("₦X added
 * to your wallet") here — landing back from Paystack only means the user
 * completed the checkout, not that the webhook has confirmed it yet (see
 * dashboard/page.tsx's note on wallet_apply_transaction always writing
 * status='completed' synchronously on webhook receipt, which may not have
 * landed the instant the browser redirects back). One router.refresh() on
 * mount picks it up if it already has.
 */
function useDepositReturnBanner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (searchParams.get('deposit') !== 'success') return;
    setVisible(true);
    router.refresh();
    router.replace('/dashboard');
    const timeout = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;
  return (
    <div className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm text-info">
      Payment received — confirming your deposit…
    </div>
  );
}

export function DashboardClient({
  initialNetWorth,
  initialPnl,
  livePositions,
  fundedAccounts,
  totalPositionCount,
  unpricedHoldings,
  initialPods,
  initialSnapshots,
  dailyVideo,
  hasConnectedBroker,
  offers,
  wallet,
}: DashboardClientProps) {
  const depositReturnBanner = useDepositReturnBanner();

  if (!hasConnectedBroker && totalPositionCount === 0) {
    return <EmptyDashboardState dailyVideo={dailyVideo} offers={offers} wallet={wallet} />;
  }

  const isPnlPositive = Number(initialPnl.amount) >= 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      {depositReturnBanner}

      <WalletCard wallet={wallet} />

      {/* Hero net worth card */}
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-10 -top-16 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Total Portfolio Value
        </p>
        <p className="mt-1 font-display text-4xl font-bold tracking-tight text-text-primary">
          {formatMoneyJSON(initialNetWorth)}
        </p>
        <div className="mt-3 flex items-center gap-2 font-mono-num text-sm">
          {isPnlPositive ? (
            <TrendingUp className="h-4 w-4 text-success" />
          ) : (
            <TrendingDown className="h-4 w-4 text-warning" />
          )}
          <span className={isPnlPositive ? 'text-success' : 'text-warning'}>
            {formatMoneyJSON(initialPnl)} unrealized
          </span>
        </div>
        {unpricedHoldings.length > 0 && (
          <p className="mt-2 text-xs text-warning">
            Couldn&apos;t price {unpricedHoldings.join(', ')} in {initialNetWorth.currency} — excluded from the
            totals above, not counted as zero.
          </p>
        )}
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
            {formatMoneyJSON(initialPnl)}
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
              const positive = position.unrealizedPnl !== null && Number(position.unrealizedPnl.amount) >= 0;

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
                    {position.unrealizedPnl !== null ? (
                      <>
                        <p className={positive ? 'text-success' : 'text-warning'}>
                          {formatMoneyJSON(position.unrealizedPnl)}
                        </p>
                        <p className={`text-xs ${positive ? 'text-success' : 'text-warning'}`}>
                          {formatPercentage(position.unrealizedPnlPct ?? 0)}
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

      {/* Funded accounts — simulated broker connections (Partner Offers v1),
          one row per account (Valuation Contract's PropAccountProvider),
          not per position. Never shown alongside real dollar P&L: challenge
          progress only. */}
      {fundedAccounts.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <CardTitle>Funded accounts</CardTitle>
            <Badge>Simulated capital</Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="mb-2 text-xs text-text-tertiary">
              Not your own funds — excluded from your net worth above.
            </p>
            {fundedAccounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between border-b border-border py-3 last:border-none"
              >
                <p className="text-sm font-semibold text-text-primary">{account.label}</p>
                <div className="text-right font-mono-num text-sm">
                  {account.value !== null ? (
                    <>
                      <p className="text-text-primary">{formatMoneyJSON(account.value)}</p>
                      <p className="text-xs text-text-tertiary">challenge progress</p>
                    </>
                  ) : (
                    <p className="text-xs text-text-tertiary">Couldn&apos;t price</p>
                  )}
                </div>
              </div>
            ))}
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
              {initialPods.map((pod) => (
                <div key={pod.id} className="rounded-lg border border-border bg-surface-elevated p-4">
                  <p className="mb-3 text-sm font-semibold text-text-primary">{pod.name}</p>
                  <div className="h-1.5 w-full rounded-full bg-border">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pod.progressPct}%`, backgroundColor: pod.color }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between font-mono-num text-xs text-text-secondary">
                    <span>{formatMoneyJSON(pod.currentAmount)}</span>
                    <span>{formatMoneyJSON(pod.targetAmount)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyDashboardState({
  dailyVideo,
  offers,
  wallet,
}: {
  dailyVideo: AcademyVideo | null;
  offers: OfferCardData[];
  wallet: DashboardWallet;
}) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="w-full max-w-sm">
        <WalletCard wallet={wallet} compact />
      </div>

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
