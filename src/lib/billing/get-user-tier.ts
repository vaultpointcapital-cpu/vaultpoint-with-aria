import { createClient } from '@/lib/supabase/server';
import type { SubscriptionTier } from '@/types/database';

/**
 * Server-only — reads next/headers via the Supabase server client, so
 * this must never be imported from a Client Component. Reads the user's
 * current tier from subscriptions (their most recent active/trialing
 * row), falling back to 'free' if no row exists — a user who has never
 * subscribed has no subscriptions row at all, that's expected, not an
 * error.
 */
export async function getUserTier(userId: string): Promise<SubscriptionTier> {
  const supabase = createClient();

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
