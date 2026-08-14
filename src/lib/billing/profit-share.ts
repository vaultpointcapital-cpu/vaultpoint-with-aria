import { createServiceClient } from '@/lib/supabase/server';
import { getStripeClient } from '@/lib/billing/stripe';
import type { ProfitShareStatus } from '@/types/database';
import { PROFIT_SHARE_PCT, type AttributedTrade } from '@/lib/billing/profit-share-shared';

export { PROFIT_SHARE_PCT, type AttributedTrade };

/**
 * The previous full calendar month (UTC), as a [start, end) date pair —
 * e.g. run in any July day returns June 1 through July 1. A billing run
 * always bills a COMPLETED month, never the one still in progress,
 * since trades placed later this month haven't happened yet.
 */
export function getPreviousCalendarMonth(reference: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));
  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
  };
}

export type BillingClient = ReturnType<typeof createServiceClient>;

/**
 * Sums realized_pnl from signal_outcomes joined (in two steps, not a
 * single query — see managed_mode.py's _kill_switch_tripped for the
 * same pattern on the Python side) through signal_actions where
 * initiated_by='aria', for one user within [periodStart, periodEnd).
 * Manual Signal Mode executions (initiated_by='user') never count
 * toward this — profit-share bills only on trades Aria placed
 * autonomously under Managed Mode.
 *
 * Takes an explicit client so the same logic serves two different
 * trust contexts: the billing run (runProfitShareForUser, below) needs
 * the service-role client since it runs across every user with no
 * logged-in session; the user-facing statement routes
 * (src/app/api/billing/profit-share) pass the caller's own RLS-scoped
 * client instead, so a user viewing "this period so far" can never
 * see anything RLS wouldn't already let them see directly.
 */
export async function computeAttributedProfit(
  supabase: BillingClient,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<number> {
  const { data: actions } = await supabase
    .from('signal_actions')
    .select('id')
    .eq('user_id', userId)
    .eq('initiated_by', 'aria')
    .eq('action', 'executed');

  const actionIds = (actions ?? []).map((a) => a.id);
  if (actionIds.length === 0) return 0;

  const { data: outcomes } = await supabase
    .from('signal_outcomes')
    .select('realized_pnl')
    .in('signal_action_id', actionIds)
    .gte('closed_at', periodStart)
    .lt('closed_at', periodEnd);

  return (outcomes ?? []).reduce((sum, o) => sum + o.realized_pnl, 0);
}

/**
 * The current, still-in-progress calendar month, [1st, tomorrow) —
 * unlike getPreviousCalendarMonth (a COMPLETED month, the only kind a
 * billing run ever charges), this is for the user-facing "this period
 * so far" preview: real trades that have already closed this month,
 * even though the actual true-up charge for this period won't happen
 * until it's over. periodEnd is tomorrow's date, not today's, so
 * computeAttributedProfit's `lt('closed_at', periodEnd)` correctly
 * includes everything closed earlier today (a timestamptz compared
 * against today's bare date would otherwise exclude today entirely).
 */
export function getCurrentCalendarMonthToDate(reference: Date = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const periodStart = new Date(Date.UTC(year, month, 1));
  const exclusiveEnd = new Date(Date.UTC(year, month, reference.getUTCDate() + 1));
  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: exclusiveEnd.toISOString().slice(0, 10),
  };
}

/**
 * The itemized trade list behind computeAttributedProfit's aggregate
 * number — this is what makes a statement "itemized" rather than just
 * a single total. Same [periodStart, periodEnd) window, same
 * initiated_by='aria' + action='executed' filter, same explicit-client
 * pattern and reasoning as computeAttributedProfit above. A trade
 * whose signal_actions/signals rows can't be found (should be
 * unreachable given the foreign keys, but this is real money reporting
 * — silently dropped rather than surfaced as a broken row) is filtered
 * out rather than crashing the whole statement.
 */
export async function listAttributedTrades(
  supabase: BillingClient,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<AttributedTrade[]> {
  const { data: actions } = await supabase
    .from('signal_actions')
    .select('id, signal_id, executed_size')
    .eq('user_id', userId)
    .eq('initiated_by', 'aria')
    .eq('action', 'executed');

  const actionList = actions ?? [];
  if (actionList.length === 0) return [];

  const actionIds = actionList.map((a) => a.id);
  const { data: outcomes } = await supabase
    .from('signal_outcomes')
    .select('signal_action_id, realized_pnl, result, closed_at')
    .in('signal_action_id', actionIds)
    .gte('closed_at', periodStart)
    .lt('closed_at', periodEnd);

  const outcomeList = outcomes ?? [];
  if (outcomeList.length === 0) return [];

  const signalIds = [...new Set(actionList.map((a) => a.signal_id))];
  const { data: signals } = await supabase.from('signals').select('id, pair, direction').in('id', signalIds);

  const actionById = new Map(actionList.map((a) => [a.id, a]));
  const signalById = new Map((signals ?? []).map((s) => [s.id, s]));

  const trades: AttributedTrade[] = [];
  for (const outcome of outcomeList) {
    const action = actionById.get(outcome.signal_action_id);
    const signal = action ? signalById.get(action.signal_id) : undefined;
    if (!action || !signal) continue;

    trades.push({
      signalId: action.signal_id,
      pair: signal.pair,
      direction: signal.direction as 'long' | 'short',
      executedSize: action.executed_size ?? 0,
      realizedPnl: outcome.realized_pnl,
      result: outcome.result as 'win' | 'loss' | 'breakeven',
      closedAt: outcome.closed_at,
    });
  }

  return trades.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}

/**
 * Charges a Stripe customer off-session for the true-up amount, using
 * whatever payment method Stripe has on file as their default — the one
 * their original subscription checkout attached, unless they've since
 * changed it. Throws (never silently no-ops) on any failure: a missing
 * default payment method, a declined card, or a non-succeeded
 * PaymentIntent status are all real reasons this charge did not happen
 * and the caller must record it as 'failed', not 'charged'.
 */
export async function chargeStripeProfitShare(params: {
  customerId: string;
  amountUsd: number;
}): Promise<{ providerChargeId: string }> {
  const stripe = getStripeClient();

  const customer = await stripe.customers.retrieve(params.customerId);
  if (customer.deleted) {
    throw new Error('Stripe customer has been deleted.');
  }

  const defaultPaymentMethod = customer.invoice_settings.default_payment_method;
  if (!defaultPaymentMethod) {
    throw new Error('No default payment method on file for this Stripe customer.');
  }
  const paymentMethodId =
    typeof defaultPaymentMethod === 'string' ? defaultPaymentMethod : defaultPaymentMethod.id;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(params.amountUsd * 100),
    currency: 'usd',
    customer: params.customerId,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    description: 'VaultPoint Signal Mode profit-share true-up',
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`Stripe payment intent did not succeed: status=${paymentIntent.status}`);
  }

  return { providerChargeId: paymentIntent.id };
}

export interface ProfitShareRunResult {
  userId: string;
  status: ProfitShareStatus;
  attributedProfit: number;
  feeAmount: number;
  reason?: string;
}

/**
 * Runs profit-share billing for exactly one user and one period,
 * idempotently: checks profit_share_charges for an existing row FIRST,
 * before computing anything, so a retried or overlapping run can never
 * double-bill. Every code path — already billed, no profit, no payment
 * method, provider rejection, success — ends in exactly one
 * profit_share_charges row.
 *
 * Paystack subscribers are deliberately failed rather than charged: the
 * amount here is in USD (Aria-attributed profit is computed from
 * realized_pnl, which is USD throughout this codebase), but Paystack
 * subscriptions in this app are NGN (see src/lib/billing/routing.ts).
 * Charging the raw USD figure through Paystack would bill the wrong
 * amount by whatever the real USD/NGN rate is — there is no FX-rate
 * source anywhere in this codebase to convert correctly, so this fails
 * loudly for a human to resolve rather than silently mis-charging a
 * real user's card.
 */
export async function runProfitShareForUser(
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<ProfitShareRunResult> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('profit_share_charges')
    .select('id')
    .eq('user_id', userId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle();

  if (existing) {
    return {
      userId,
      status: 'skipped',
      attributedProfit: 0,
      feeAmount: 0,
      reason: 'Already billed for this period.',
    };
  }

  const attributedProfit = await computeAttributedProfit(supabase, userId, periodStart, periodEnd);

  if (attributedProfit <= 0) {
    await supabase.from('profit_share_charges').insert({
      user_id: userId,
      period_start: periodStart,
      period_end: periodEnd,
      attributed_profit: attributedProfit,
      fee_amount: 0,
      fee_currency: 'usd',
      payment_provider: null,
      provider_charge_id: null,
      status: 'skipped',
      failure_reason: null,
    });
    return { userId, status: 'skipped', attributedProfit, feeAmount: 0 };
  }

  // Rounded to cents — attributedProfit and PROFIT_SHARE_PCT are both
  // arbitrary-precision numerics from Postgres, but a card charge must
  // be a whole number of cents.
  const feeAmount = Math.round(attributedProfit * (PROFIT_SHARE_PCT / 100) * 100) / 100;

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('payment_provider, provider_customer_id')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!subscription?.payment_provider || !subscription.provider_customer_id) {
    return _recordFailure(
      supabase,
      { userId, periodStart, periodEnd, attributedProfit, feeAmount },
      null,
      'No active subscription or payment method on file.'
    );
  }

  if (subscription.payment_provider === 'paystack') {
    return _recordFailure(
      supabase,
      { userId, periodStart, periodEnd, attributedProfit, feeAmount },
      'paystack',
      'Paystack profit-share billing requires USD/NGN conversion, which is not yet implemented.'
    );
  }

  try {
    const { providerChargeId } = await chargeStripeProfitShare({
      customerId: subscription.provider_customer_id,
      amountUsd: feeAmount,
    });

    await supabase.from('profit_share_charges').insert({
      user_id: userId,
      period_start: periodStart,
      period_end: periodEnd,
      attributed_profit: attributedProfit,
      fee_amount: feeAmount,
      fee_currency: 'usd',
      payment_provider: 'stripe',
      provider_charge_id: providerChargeId,
      status: 'charged',
      failure_reason: null,
    });

    return { userId, status: 'charged', attributedProfit, feeAmount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return _recordFailure(
      supabase,
      { userId, periodStart, periodEnd, attributedProfit, feeAmount },
      'stripe',
      message
    );
  }
}

async function _recordFailure(
  supabase: ReturnType<typeof createServiceClient>,
  params: { userId: string; periodStart: string; periodEnd: string; attributedProfit: number; feeAmount: number },
  provider: 'stripe' | 'paystack' | null,
  reason: string
): Promise<ProfitShareRunResult> {
  await supabase.from('profit_share_charges').insert({
    user_id: params.userId,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    attributed_profit: params.attributedProfit,
    fee_amount: params.feeAmount,
    fee_currency: 'usd',
    payment_provider: provider,
    provider_charge_id: null,
    status: 'failed',
    failure_reason: reason.slice(0, 500),
  });

  return {
    userId: params.userId,
    status: 'failed',
    attributedProfit: params.attributedProfit,
    feeAmount: params.feeAmount,
    reason,
  };
}
