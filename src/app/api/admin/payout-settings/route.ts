import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { updatePayoutSettingsSchema } from '@/lib/validations/payouts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { PayoutSettings } from '@/types/database';

/**
 * GET/PUT /api/admin/payout-settings
 *
 * The singleton payout_settings row — where VaultPoint's cut should be
 * sent for the crypto_two_step collection method. Null
 * vaultpoint_crypto_wallet_address means calculate_payout_split() writes
 * a payout_ledger row with no VaultPoint destination yet — visible and
 * fixable in the admin UI, never silently defaulted to some placeholder
 * address.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: settings, error } = await admin.from('payout_settings').select('*').eq('id', 1).single();
  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not load payout settings.');

  return apiSuccess({ settings });
}

export async function PUT(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = updatePayoutSettingsSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid settings update.', parsed.error.flatten());

  const admin = createServiceClient();
  const updates: Partial<Omit<PayoutSettings, 'id' | 'updated_at'>> = { updated_by: authData.user.id };
  if (parsed.data.vaultpointCryptoWalletAddress !== undefined) {
    updates.vaultpoint_crypto_wallet_address = parsed.data.vaultpointCryptoWalletAddress;
  }
  if (parsed.data.vaultpointCryptoNetwork !== undefined) {
    updates.vaultpoint_crypto_network = parsed.data.vaultpointCryptoNetwork;
  }

  const { data: settings, error } = await admin
    .from('payout_settings')
    .update(updates)
    .eq('id', 1)
    .select('*')
    .single();

  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not update payout settings.');

  return apiSuccess({ settings });
}
