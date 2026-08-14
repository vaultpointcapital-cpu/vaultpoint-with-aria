import type { SupabaseClient } from '@supabase/supabase-js';
import { HIGH_DRAWDOWN_WARNING_RATIO } from '@/lib/validations/managed-accounts';
import type { Database, ManagedAccountNotificationType } from '@/types/database';

/**
 * Inserts a managed_account_notifications row through the caller's own
 * RLS-scoped client — every call site already has an authenticated user
 * acting on their own account (signing, funding, requesting a
 * withdrawal), so the insert policy's auth.uid() = user_id check is
 * exactly the right scope. Never awaited by call sites in a way that
 * blocks the user-facing response on notification delivery succeeding —
 * see each call site's own comment for why a failure here is logged,
 * not surfaced as the request's own error.
 */
export async function createNotification(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    managedAccountId: string;
    type: ManagedAccountNotificationType;
    title: string;
    body: string;
  }
): Promise<void> {
  const { error } = await supabase.from('managed_account_notifications').insert({
    user_id: params.userId,
    managed_account_id: params.managedAccountId,
    type: params.type,
    title: params.title,
    body: params.body,
    read_at: null,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to create managed account notification:', error.message);
  }
}

/**
 * The drawdown warning's own acceptance criteria is "must never be
 * suppressed" — so this doesn't check whether the client has READ a
 * prior warning (read_at), only whether one was already CREATED
 * recently, to avoid inserting a duplicate on every single dashboard
 * page load while the account sits at the same elevated drawdown. 24h
 * is a placeholder re-alert cadence, not a spec'd number.
 */
const DRAWDOWN_WARNING_DEDUPE_HOURS = 24;
const WITHDRAWAL_WINDOW_DEDUPE_HOURS = 24;

export async function maybeNotifyDrawdownWarning(
  supabase: SupabaseClient<Database>,
  params: { userId: string; managedAccountId: string; drawdownPct: number; maxDrawdownPct: number }
): Promise<void> {
  if (params.drawdownPct < params.maxDrawdownPct * HIGH_DRAWDOWN_WARNING_RATIO) return;

  const since = new Date(Date.now() - DRAWDOWN_WARNING_DEDUPE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('managed_account_notifications')
    .select('id')
    .eq('managed_account_id', params.managedAccountId)
    .eq('type', 'drawdown_warning')
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();

  if (recent) return;

  await createNotification(supabase, {
    userId: params.userId,
    managedAccountId: params.managedAccountId,
    type: 'drawdown_warning',
    title: 'Drawdown approaching policy maximum',
    body: `Your account's drawdown is ${params.drawdownPct.toFixed(1)}%, at or above 80% of the ${params.maxDrawdownPct}% policy maximum.`,
  });
}

export async function maybeNotifyWithdrawalWindowOpen(
  supabase: SupabaseClient<Database>,
  params: { userId: string; managedAccountId: string; nextWithdrawalWindowDate: string | null }
): Promise<void> {
  if (!params.nextWithdrawalWindowDate) return;
  if (new Date(params.nextWithdrawalWindowDate) > new Date()) return;

  const since = new Date(Date.now() - WITHDRAWAL_WINDOW_DEDUPE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('managed_account_notifications')
    .select('id')
    .eq('managed_account_id', params.managedAccountId)
    .eq('type', 'withdrawal_window_open')
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();

  if (recent) return;

  await createNotification(supabase, {
    userId: params.userId,
    managedAccountId: params.managedAccountId,
    type: 'withdrawal_window_open',
    title: 'Withdrawal window open',
    body: 'Your next withdrawal window is open — you can request a withdrawal from your account dashboard.',
  });
}
