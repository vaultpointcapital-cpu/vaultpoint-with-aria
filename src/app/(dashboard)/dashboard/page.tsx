import Decimal from 'decimal.js';
import { createClient } from '@/lib/supabase/server';
import { calculateTotalPnl, calculatePositionPnl, calculatePositionPnlPct, calculatePodProgress } from '@/lib/utils/financial';
import { Money } from '@/lib/money';
import { fxService, FxRateUnavailableError } from '@/lib/fx';
import { calculateNetWorthResult } from '@/lib/valuation/networth';
import { isOfferAvailableForRegion } from '@/lib/offers/routing';
import { getKycTierStatus } from '@/lib/kyc/tier-state';
import type { WalletProvider } from '@/lib/wallet/routing';
import {
  DashboardClient,
  type DisplayPosition,
  type DisplayPod,
  type DisplayFundedAccount,
  type DashboardWallet,
} from '@/components/dashboard/dashboard-client';

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [
    positionsResult,
    podsResult,
    brokerConnectionsResult,
    snapshotsResult,
    dailyVideoResult,
    profileResult,
    offersResult,
    walletsResult,
    walletTransactionsResult,
  ] = await Promise.all([
      // Valuation Contract: reality is trigger-maintained on the row
      // itself now — no broker_connections join needed to know which
      // positions are the user's own money.
      supabase
        .from('positions')
        .select('id, symbol, side, size, entry_price, mark_price, currency, reality')
        .eq('user_id', authData.user.id),
      supabase
        .from('savings_pods')
        .select('*')
        .eq('user_id', authData.user.id)
        .neq('status', 'archived'),
      supabase
        .from('broker_connections')
        .select('id, broker, label, sync_status')
        .eq('user_id', authData.user.id),
      // Written once daily by the (not-yet-deployed) Python service's
      // snapshot job — may be empty for a brand new user, which is a
      // "no history yet" state, not an error.
      supabase
        .from('portfolio_snapshots')
        .select('*')
        .eq('user_id', authData.user.id)
        .order('snapshot_date', { ascending: true }),
      // Shared content, not per-user — exactly one active row expected at
      // a time (see supabase/migrations/20260716000002_add_academy_videos.sql).
      supabase
        .from('academy_videos')
        .select('*')
        .eq('video_type', 'daily_short')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle(),
      supabase.from('users').select('country_code, display_currency').eq('id', authData.user.id).single(),
      // Partner Offers v1 — same query GET /api/offers runs, done server-side
      // here since this page already SSRs every other piece of dashboard data.
      supabase
        .from('partner_offers')
        .select('id, partner_slug, program, account_size_usd, price_from_usd, ref_url, affiliate_code, regions_allowed')
        .eq('active', true),
      // Dashboard Wallet Card — see wallet-card.tsx. Only the fields the
      // card actually renders; the full multi-currency grid still lives
      // on /dashboard/wallet with its own SSR query.
      supabase.from('wallets').select('id, currency, balance_cached, updated_at').eq('user_id', authData.user.id),
      supabase
        .from('wallet_transactions')
        .select('id, type, amount, currency, status, provider, created_at')
        .eq('user_id', authData.user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(20),
    ]);

  const positions = positionsResult.data ?? [];
  const pods = podsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];
  const snapshots = snapshotsResult.data ?? [];
  const dailyVideo = dailyVideoResult.data ?? null;
  const displayCurrency = profileResult.data?.display_currency ?? 'USD';
  const offers = (offersResult.data ?? [])
    .filter((offer) => isOfferAvailableForRegion(offer, profileResult.data?.country_code))
    .map((offer) => ({
      id: offer.id,
      partner: offer.partner_slug,
      program: offer.program,
      account_size_usd: offer.account_size_usd,
      price_from_usd: offer.price_from_usd,
      affiliate_code: offer.affiliate_code,
    }));

  // Dashboard Wallet Card data — see src/components/dashboard/wallet-card.tsx.
  // Money & Currency Layer: computed server-side into plain MoneyJSON,
  // same convention as netWorthResult below — DashboardClient never
  // touches Money/financial.ts directly.
  const wallet: DashboardWallet = await (async () => {
    if (walletsResult.error || walletTransactionsResult.error) {
      return {
        error: true,
        currency: displayCurrency,
        balance: null,
        pendingAmount: null,
        hasAnyWallet: false,
        wallets: [],
        lastTransaction: null,
        lastUsedRail: { currency: 'NGN', provider: 'paystack' },
        kycTier: 'tier0',
        kycLimits: null,
      };
    }

    const wallets = walletsResult.data ?? [];
    const walletTransactions = walletTransactionsResult.data ?? [];

    const primaryWallet =
      wallets.find((w) => w.currency === displayCurrency) ?? wallets.find((w) => w.currency === 'NGN') ?? null;
    const primaryCurrency = primaryWallet?.currency ?? displayCurrency;

    // wallet_apply_transaction() (20260802000000_add_wallet.sql) hardcodes
    // status='completed' on every insert — no code path writes 'pending'
    // today, so this will compute to 0 in practice. Still derived
    // correctly (not hardcoded to 0) since it's cheap and matches the
    // component spec; not a bug to chase if it's ever built.
    const pendingTotal = walletTransactions
      .filter((t) => t.status === 'pending' && t.currency === primaryCurrency)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const lastTxn = walletTransactions[0] ?? null;

    // DB provider enum ('paystack'|'stripe'|'flutterwave'|'web3'|'internal')
    // -> app-level WalletProvider ('paystack'|'stripe'|'crypto'), the
    // inverse of walletProviderToDbEnum() in src/lib/wallet/routing.ts.
    const lastDeposit = walletTransactions.find((t) => t.type === 'deposit');
    const lastUsedRail: { currency: string; provider: WalletProvider } | null = lastDeposit
      ? {
          currency: lastDeposit.currency,
          provider: lastDeposit.provider === 'web3' ? 'crypto' : (lastDeposit.provider as WalletProvider),
        }
      : null;

    let kycTier: import('@/types/database').KycTier = 'tier0';
    let kycLimits: DashboardWallet['kycLimits'] = null;
    try {
      const status = await getKycTierStatus(authData.user.id);
      kycTier = status.tier;
      kycLimits = status.limits;
    } catch {
      // KYC status is non-critical for the wallet card's balance display —
      // fall back to the most restrictive tier rather than fail the whole
      // dashboard render.
    }

    return {
      error: false,
      currency: primaryCurrency,
      balance: primaryWallet ? Money.of(String(primaryWallet.balance_cached), primaryCurrency).toJSON() : null,
      pendingAmount: pendingTotal > 0 ? Money.of(String(pendingTotal), primaryCurrency).toJSON() : null,
      hasAnyWallet: wallets.length > 0,
      // Full multi-currency list — the withdraw modal keeps its existing
      // per-currency picker (see withdraw-dialog.tsx), only the compact
      // card's own headline number is narrowed to primaryCurrency.
      wallets: wallets.map((w) => ({ currency: w.currency, balance_cached: w.balance_cached, updated_at: w.updated_at })),
      lastTransaction: lastTxn
        ? {
            type: lastTxn.type,
            amount: Money.of(String(lastTxn.amount), lastTxn.currency).toJSON(),
            status: lastTxn.status,
          }
        : null,
      lastUsedRail: lastUsedRail ?? { currency: 'NGN', provider: 'paystack' },
      kycTier,
      kycLimits,
    };
  })();

  // Valuation Contract — the one aggregator every net-worth-relevant
  // source runs through (src/lib/valuation/networth.ts). Money &
  // Currency Layer: decimal.js/Money only ever runs server-side (this
  // SSR page, API routes, Python) — DashboardClient ('use client') never
  // imports financial.ts/money.ts, only already-computed MoneyJSON/
  // plain-number props from here.
  const netWorthResult = await calculateNetWorthResult(authData.user.id, displayCurrency);

  const fundedAccounts: DisplayFundedAccount[] = netWorthResult.excluded
    .filter((h) => h.sourceType === 'prop_account')
    .map((h) => ({ id: h.sourceId, label: h.label, value: h.valueInDisplayCurrency?.toJSON() ?? null }));

  // Per-position P&L is a separate concern from valuation (Holding is
  // current value, not P&L attribution — see the Valuation Contract's own
  // §10) — computed here directly from `positions`, same convention as
  // before: per-position figures stay in native currency, only the
  // aggregate total below is converted to displayCurrency.
  const realPositions = positions.filter((p) => p.reality === 'real');

  async function convertToDisplay(money: Money): Promise<Money | null> {
    if (money.currency === displayCurrency) return money;
    try {
      const { money: converted } = await fxService.convert(money, displayCurrency);
      return converted;
    } catch (err) {
      if (err instanceof FxRateUnavailableError) return null;
      throw err;
    }
  }

  const convertedPositionsForPnl = (
    await Promise.all(
      realPositions.map(async (p) => {
        const entryPrice = await convertToDisplay(Money.of(String(p.entry_price), p.currency));
        if (!entryPrice) return null;
        const markPrice = p.mark_price === null ? null : await convertToDisplay(Money.of(String(p.mark_price), p.currency));
        if (p.mark_price !== null && !markPrice) return null;
        return { side: p.side, size: new Decimal(String(p.size)), entryPrice, markPrice };
      })
    )
  ).filter((p): p is NonNullable<typeof p> => p !== null);

  const totalUnrealizedPnl = calculateTotalPnl(convertedPositionsForPnl, displayCurrency);

  function toDisplayPosition(p: (typeof positions)[number]): DisplayPosition {
    if (p.mark_price === null) {
      return { id: p.id, symbol: p.symbol, side: p.side, size: p.size, unrealizedPnl: null, unrealizedPnlPct: null };
    }
    const entryPrice = Money.of(String(p.entry_price), p.currency);
    const markPrice = Money.of(String(p.mark_price), p.currency);
    const size = new Decimal(String(p.size));
    return {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      unrealizedPnl: calculatePositionPnl({ side: p.side, size, entryPrice, markPrice }).toJSON(),
      unrealizedPnlPct: calculatePositionPnlPct({ side: p.side, size, entryPrice, markPrice }),
    };
  }

  const livePositions = realPositions.map(toDisplayPosition);

  const displayPods: DisplayPod[] = pods.map((pod) => {
    const currentAmount = Money.of(String(pod.current_amount), pod.currency);
    const targetAmount = Money.of(String(pod.target_amount), pod.currency);
    return {
      id: pod.id,
      name: pod.name,
      color: pod.color,
      currentAmount: currentAmount.toJSON(),
      targetAmount: targetAmount.toJSON(),
      progressPct: calculatePodProgress(currentAmount, targetAmount),
    };
  });

  return (
    <DashboardClient
      initialNetWorth={netWorthResult.total.toJSON()}
      initialPnl={totalUnrealizedPnl.toJSON()}
      livePositions={livePositions}
      fundedAccounts={fundedAccounts}
      totalPositionCount={positions.length}
      unpricedHoldings={netWorthResult.unpriced.map((h) => h.label)}
      initialPods={displayPods}
      initialSnapshots={snapshots}
      dailyVideo={dailyVideo}
      hasConnectedBroker={brokerConnections.length > 0}
      offers={offers}
      wallet={wallet}
    />
  );
}
