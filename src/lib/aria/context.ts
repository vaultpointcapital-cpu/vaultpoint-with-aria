import { createClient } from '@/lib/supabase/server';
import { calculateNetWorthResult, type ValuedHolding } from '@/lib/valuation/networth';
import { fxService, FxRateUnavailableError } from '@/lib/fx';
import { calculateDayChange } from '@/lib/utils/financial';
import { Money, type MoneyJSON } from '@/lib/money';
import { resolveAriaComplianceRegion, resolveApproxTimezone, getRegionNotes } from '@/lib/aria/region';
import { computeCoolDown } from '@/lib/aria/compliance';
import { getCachedAriaContext, setCachedAriaContext } from '@/lib/aria/cache';
import type { AriaContext, AriaHolding, AriaConfidence } from '@/lib/aria/types';
import type { Holding } from '@/lib/valuation/types';

// Connections whose health means their data shouldn't be trusted for a
// portfolio-wide compliance decision — same bucket the Connection Health
// build's alert suppression uses (health not in healthy/pending).
const HEALTHY_LIKE = new Set(['healthy', 'pending']);
const NO_SYNC_UNUSABLE_AFTER_MS = 30 * 60 * 1000;
const STALE_VALUE_UNUSABLE_RATIO = 0.5;

function toAriaHolding(h: ValuedHolding | Holding): AriaHolding {
  const unrealisedPct =
    h.costBasis && !h.costBasis.isZero()
      ? h.value.minus(h.costBasis).ratioTo(h.costBasis).times(100).toFixed(2)
      : null;

  return {
    label: h.label,
    assetClass: h.assetClass,
    value: h.value.toJSON(),
    unrealisedPct,
    reality: h.reality,
    liquidity: h.liquidity,
    stale: h.stale,
    asOf: h.asOf.toISOString(),
  };
}

interface ConnectionHealthRow {
  label: string;
  health: string;
  last_success_at: string | null;
}

function computeConfidence(params: {
  totalValue: Money;
  staleValue: Money;
  connections: readonly ConnectionHealthRow[];
}): AriaConfidence {
  const { totalValue, staleValue, connections } = params;

  const staleRatio = totalValue.isZero() ? 0 : staleValue.ratioTo(totalValue).toNumber();
  const staleValuePastThreshold = staleRatio > STALE_VALUE_UNUSABLE_RATIO;

  const hasConnections = connections.length > 0;
  const mostRecentSuccess = connections.reduce<number | null>((latest, c) => {
    if (!c.last_success_at) return latest;
    const t = new Date(c.last_success_at).getTime();
    return latest === null || t > latest ? t : latest;
  }, null);
  const noRecentSync =
    hasConnections && (mostRecentSuccess === null || Date.now() - mostRecentSuccess > NO_SYNC_UNUSABLE_AFTER_MS);

  if (staleValuePastThreshold || noRecentSync) return 'unusable';

  const anyDegraded = connections.some((c) => !HEALTHY_LIKE.has(c.health));
  const anyStaleHolding = staleValue.isZero() === false;
  if (anyDegraded || anyStaleHolding) return 'partial';

  return 'full';
}

/**
 * Aria Context Builder — the one function every Aria surface reads
 * context from. See src/lib/aria/types.ts for the payload shape and the
 * plan's "Reconciling the spec against what's actually in this
 * codebase" for why several fields are derived/approximated rather than
 * stored (region, timezone) or scoped down (D6's snapshot table).
 */
export async function buildAriaContext(userId: string): Promise<AriaContext> {
  const cached = await getCachedAriaContext(userId);
  if (cached) {
    // §7: never trust cached freshness/health — only the expensive
    // valuation aggregation is worth caching. Recomputed against live
    // broker_connections state on every read, cache hit or not.
    return recomputeDataQualityAndCompliance(userId, cached);
  }

  const supabase = createClient();

  const { data: profile } = await supabase
    .from('users')
    .select('display_currency, country_code, subscription_tier')
    .eq('id', userId)
    .single();

  const displayCurrency = profile?.display_currency ?? 'USD';
  const region = resolveAriaComplianceRegion(profile?.country_code ?? null);
  const timezone = resolveApproxTimezone(profile?.country_code ?? null);
  const tier = profile?.subscription_tier ?? 'free';

  const today = new Date().toISOString().slice(0, 10);

  const [netWorthResult, connectionsResult, yesterdaySnapshotResult, podsResult] = await Promise.all([
    calculateNetWorthResult(userId, displayCurrency),
    supabase
      .from('broker_connections')
      .select('label, health, last_success_at')
      .eq('user_id', userId)
      .neq('health', 'closed'),
    supabase
      .from('portfolio_snapshots')
      .select('total_net_worth, currency')
      .eq('user_id', userId)
      .lt('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('savings_pods')
      .select('name, target_amount, current_amount, currency, deadline')
      .eq('user_id', userId)
      .neq('status', 'archived'),
  ]);

  const connections = connectionsResult.data ?? [];
  const degradedSources = connections.filter((c) => !HEALTHY_LIKE.has(c.health)).map((c) => c.label);

  const staleHoldings = netWorthResult.included.filter((h) => h.stale);
  const staleValue = staleHoldings.reduce(
    (sum, h) => (h.valueInDisplayCurrency ? sum.plus(h.valueInDisplayCurrency) : sum),
    Money.zero(displayCurrency)
  );

  const confidence = computeConfidence({ totalValue: netWorthResult.total, staleValue, connections });

  const { coolDown, dayChangePct } = await computeCoolDownAndDayChange(
    netWorthResult.total,
    yesterdaySnapshotResult.data ?? null,
    displayCurrency
  );

  const byAssetClass: Record<string, MoneyJSON> = {};
  for (const [assetClass, money] of netWorthResult.byAssetClass) {
    byAssetClass[assetClass] = money.toJSON();
  }

  const ctx: AriaContext = {
    version: '1',
    generatedAt: new Date().toISOString(),
    user: { displayCurrency, region, tier, timezone },
    portfolio: {
      totalAssets: netWorthResult.total.toJSON(),
      byAssetClass,
      dayChangePct,
      holdings: netWorthResult.included.map(toAriaHolding),
      excludedHoldings: netWorthResult.excluded.map(toAriaHolding),
      unpricedCount: netWorthResult.unpriced.length,
    },
    dataQuality: {
      stale: netWorthResult.stale,
      oldestAsOf: netWorthResult.asOf.toISOString(),
      degradedSources,
      confidence,
    },
    compliance: {
      coolDownActive: coolDown.active,
      coolDownReason: coolDown.reason,
      disclaimerRequired: confidence !== 'unusable',
      regionNotes: getRegionNotes(region),
    },
    pods: (podsResult.data ?? []).map((pod) => ({
      label: pod.name,
      target: Money.of(String(pod.target_amount), pod.currency).toJSON(),
      current: Money.of(String(pod.current_amount), pod.currency).toJSON(),
      daysRemaining: daysRemaining(pod.deadline),
    })),
  };

  await setCachedAriaContext(userId, ctx);
  await snapshotContext(userId, ctx);

  return ctx;
}

async function computeCoolDownAndDayChange(
  todayTotal: Money,
  yesterdaySnapshot: { total_net_worth: number; currency: string } | null,
  displayCurrency: string
): Promise<{ coolDown: { active: boolean; reason: string | null }; dayChangePct: string | null }> {
  if (!yesterdaySnapshot) {
    return { coolDown: { active: false, reason: null }, dayChangePct: null };
  }

  try {
    const rawYesterday = Money.of(String(yesterdaySnapshot.total_net_worth), yesterdaySnapshot.currency);
    const { money: yesterdayInDisplayCurrency } = await fxService.convert(rawYesterday, displayCurrency);
    const coolDown = computeCoolDown(todayTotal, yesterdayInDisplayCurrency);
    const { percentage } = calculateDayChange(todayTotal, yesterdayInDisplayCurrency);
    return { coolDown, dayChangePct: percentage.toFixed(2) };
  } catch (err) {
    if (err instanceof FxRateUnavailableError) {
      // No rate to compare fairly — never fabricate a cool-down/change
      // figure off an unconverted mismatch (spec §5).
      return { coolDown: { active: false, reason: null }, dayChangePct: null };
    }
    throw err;
  }
}

function daysRemaining(deadline: string | null): number | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

async function snapshotContext(userId: string, ctx: AriaContext): Promise<void> {
  try {
    const supabase = createClient();
    await supabase.from('aria_context_snapshots').insert({
      user_id: userId,
      payload: ctx as unknown as Record<string, unknown>,
      generated_at: ctx.generatedAt,
    });
  } catch {
    // Reproducibility is valuable, not load-bearing — a snapshot-write
    // failure must never break Aria actually responding to the user.
  }
}

/**
 * Cache-hit path: re-derives dataQuality/compliance against LIVE
 * broker_connections state without rebuilding the whole valuation
 * aggregation, and without writing a new snapshot row (nothing new was
 * computed). holdings/portfolio totals are trusted from the cached
 * payload for the remainder of its 60s TTL — only freshness/health/
 * cool-down, which can change independently of net worth, are refreshed.
 */
async function recomputeDataQualityAndCompliance(userId: string, cached: AriaContext): Promise<AriaContext> {
  const supabase = createClient();
  const { data: connections } = await supabase
    .from('broker_connections')
    .select('label, health, last_success_at')
    .eq('user_id', userId)
    .neq('health', 'closed');

  const rows = connections ?? [];
  const degradedSources = rows.filter((c) => !HEALTHY_LIKE.has(c.health)).map((c) => c.label);

  const totalValue = Money.of(cached.portfolio.totalAssets.amount, cached.portfolio.totalAssets.currency);
  const staleValue = cached.portfolio.holdings
    .filter((h) => h.stale)
    .reduce((sum, h) => sum.plus(Money.of(h.value.amount, h.value.currency)), Money.zero(totalValue.currency));

  const confidence = computeConfidence({ totalValue, staleValue, connections: rows });

  return {
    ...cached,
    dataQuality: { ...cached.dataQuality, degradedSources, confidence },
    compliance: { ...cached.compliance, disclaimerRequired: confidence !== 'unusable' },
  };
}
