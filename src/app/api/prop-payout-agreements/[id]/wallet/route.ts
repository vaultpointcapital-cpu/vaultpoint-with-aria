import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { updateTraderWalletSchema } from '@/lib/validations/payouts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * PUT /api/prop-payout-agreements/:id/wallet
 *
 * The ONE field the trader sets themselves on their own agreement row —
 * never admin-set (see POST/PUT /api/admin/prop-payout-agreements, which
 * deliberately excludes this field). Session-authed, ownership-checked
 * via the RLS-scoped client before switching to service-role to write
 * (this table has no client update policy, same rule as every other
 * money table in this schema).
 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json().catch(() => null);
  const parsed = updateTraderWalletSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid wallet address.', parsed.error.flatten());

  const { data: agreement } = await supabase
    .from('prop_payout_agreements')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (!agreement) return apiError('NOT_FOUND', 'Payout agreement not found or you do not have access to it.');

  const admin = createServiceClient();
  const { data: updated, error } = await admin
    .from('prop_payout_agreements')
    .update({ trader_payout_wallet_address: parsed.data.walletAddress })
    .eq('id', agreement.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not update your payout wallet address.');

  return apiSuccess({ agreement: updated });
}
