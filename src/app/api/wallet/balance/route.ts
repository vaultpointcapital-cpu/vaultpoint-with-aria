import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/wallet/balance
 *
 * Returns the caller's wallet balance per currency. Reads balance_cached
 * directly — the single column ever written by wallet_apply_transaction()
 * (supabase/migrations/20260802000000_add_wallet.sql), so this is always
 * consistent with the ledger, never recomputed here.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('currency, balance_cached, updated_at')
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load wallet balance.');
  }

  return apiSuccess({ wallets: wallets ?? [] });
}
