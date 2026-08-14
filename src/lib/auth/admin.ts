import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Reads is_admin through the caller's own RLS-scoped client (users has a
 * "select own row" policy, same as everywhere else) — this only ever
 * confirms "is the currently-authenticated user an admin," never reads
 * anyone else's row. Admin routes then switch to createServiceClient()
 * for the actual privileged read/write, same pattern as the webhook
 * handlers use for their own trusted-context bypass.
 */
export async function isAdmin(supabase: SupabaseClient<Database>, userId: string): Promise<boolean> {
  const { data } = await supabase.from('users').select('is_admin').eq('id', userId).single();
  return data?.is_admin ?? false;
}
