import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/payouts — trader-facing (spec section 3.6). The caller's own
 * withdrawal events + payout ledger entries, RLS-scoped (no service-role
 * needed — both tables have a "select own" policy).
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const [eventsResult, ledgerResult, agreementResult] = await Promise.all([
    supabase.from('withdrawal_events').select('*').eq('user_id', authData.user.id).order('detected_at', { ascending: false }),
    supabase.from('payout_ledger').select('*').eq('user_id', authData.user.id).order('created_at', { ascending: false }),
    supabase.from('prop_payout_agreements').select('*').eq('user_id', authData.user.id).maybeSingle(),
  ]);

  if (eventsResult.error || ledgerResult.error) {
    return apiError('INTERNAL_ERROR', 'Could not load your payout history.');
  }

  return apiSuccess({
    events: eventsResult.data ?? [],
    ledgerEntries: ledgerResult.data ?? [],
    agreement: agreementResult.data ?? null,
  });
}
