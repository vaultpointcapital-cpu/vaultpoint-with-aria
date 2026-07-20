import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import type { Database, SubscriptionTier } from '@/types/database';

/**
 * Computes a user's current tier from subscriptions (their most recent
 * active/trialing row), falling back to 'free' if no row exists — a user
 * who has never subscribed has no subscriptions row at all, that's
 * expected, not an error. subscriptions is the source of truth; a
 * past_due or cancelled row does not count as active access, matching
 * how a lapsed/failed payment should behave.
 */
export async function computeUserTier(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<SubscriptionTier> {
  const { data } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
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
  const tier = await computeUserTier(supabase, userId);
  await supabase.from('users').update({ subscription_tier: tier }).eq('id', userId);
  return tier;
}
