import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { applyValueLedgerEvent } from '@/lib/value-ledger/events';
import type { Database, SubscriptionTier } from '@/types/database';

// A renewal decline doesn't revoke access immediately — the user keeps
// their tier for this long after the FIRST failed charge (past_due_since),
// not reset by later retries of the same decline episode. A cancelled row
// gets no grace period; only a failed-payment (past_due) does.
const PAST_DUE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Computes a user's current tier from subscriptions: their most recent
 * active/trialing row, OR a past_due row still within its grace period
 * (past_due_since within the last 3 days) — falls back to 'free' if
 * neither exists. A user who has never subscribed has no subscriptions
 * row at all, that's expected, not an error. A past_due row with no
 * past_due_since (or one outside the grace window), and any cancelled
 * row, do not count as active access.
 */
export async function computeUserTier(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<SubscriptionTier> {
  const graceCutoff = new Date(Date.now() - PAST_DUE_GRACE_PERIOD_MS).toISOString();

  const { data } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .or(`status.in.(active,trialing),and(status.eq.past_due,past_due_since.gte.${graceCutoff})`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.tier ?? 'free';
}

/**
 * Server-only — reads next/headers via the Supabase server client, so
 * this must never be imported from a Client Component.
 */
export async function getUserTier(userId: string): Promise<SubscriptionTier> {
  return computeUserTier(createClient(), userId);
}

/**
 * Recomputes a user's tier from their subscriptions rows and writes it to
 * the denormalized users.subscription_tier column, which is what most
 * feature-gating routes (alerts, Aria, pods, signals, managed-accounts,
 * managed-mode) and the profit-share billing cron actually read — call
 * this after any webhook write that changes a subscription's status or
 * tier, using a service-role client (webhooks have no user session to
 * scope createClient() to).
 */
export async function syncUserSubscriptionTier(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<SubscriptionTier> {
  const { data: existing } = await supabase.from('users').select('subscription_tier').eq('id', userId).single();
  const previousTier = existing?.subscription_tier;

  const tier = await computeUserTier(supabase, userId);
  await supabase.from('users').update({ subscription_tier: tier }).eq('id', userId);

  // Value Ledger — feeds tier_conversion_rate. Date-scoped idempotency key
  // so a same-day retried webhook delivery is a natural no-op.
  if (previousTier && previousTier !== tier) {
    await applyValueLedgerEvent(supabase, {
      userId,
      eventName: 'tier_changed',
      idempotencyKey: `tier_changed:${userId}:${previousTier}-${tier}:${new Date().toISOString().slice(0, 10)}`,
      properties: { fromTier: previousTier, toTier: tier },
      source: 'billing',
    });
  }

  return tier;
}
