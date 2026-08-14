import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { updatePropPayoutAgreementSchema } from '@/lib/validations/payouts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { PropPayoutAgreement } from '@/types/database';

/** PUT /api/admin/prop-payout-agreements/:id — split terms only; trader_payout_wallet_address is never admin-settable. */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = updatePropPayoutAgreementSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid update.', parsed.error.flatten());

  const admin = createServiceClient();
  const updates: Partial<Pick<PropPayoutAgreement, 'profit_split_pct' | 'split_direction' | 'active'>> = {};
  if (parsed.data.profitSplitPct !== undefined) updates.profit_split_pct = parsed.data.profitSplitPct;
  if (parsed.data.splitDirection !== undefined) updates.split_direction = parsed.data.splitDirection;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;

  const { data: agreement, error } = await admin
    .from('prop_payout_agreements')
    .update(updates)
    .eq('id', params.id)
    .select('*')
    .single();

  if (error || !agreement) return apiError('INTERNAL_ERROR', 'Could not update this payout agreement.');

  return apiSuccess({ agreement });
}
