import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { createPropPayoutAgreementSchema } from '@/lib/validations/payouts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET/POST /api/admin/prop-payout-agreements
 *
 * Admin sets the business terms (split percentage/direction, funding
 * partner) per broker_connections entry — the "profit split agreement"
 * record Issue #13 assumed existed but didn't (see the migration
 * header). trader_payout_wallet_address is deliberately never settable
 * here — see PUT /api/prop-payout-agreements/:id/wallet.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: agreements, error } = await admin
    .from('prop_payout_agreements')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return apiError('INTERNAL_ERROR', 'Could not load payout agreements.');

  return apiSuccess({ agreements: agreements ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = createPropPayoutAgreementSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid payout agreement.', parsed.error.flatten());
  const { brokerConnectionId, userId, fundingPartner, profitSplitPct, splitDirection } = parsed.data;

  const admin = createServiceClient();

  const { data: connection } = await admin
    .from('broker_connections')
    .select('id, user_id')
    .eq('id', brokerConnectionId)
    .maybeSingle();
  if (!connection || connection.user_id !== userId) {
    return apiError('VALIDATION_ERROR', 'broker_connection_id does not belong to the given user.');
  }

  const { data: agreement, error } = await admin
    .from('prop_payout_agreements')
    .insert({
      broker_connection_id: brokerConnectionId,
      user_id: userId,
      funding_partner: fundingPartner,
      profit_split_pct: profitSplitPct,
      split_direction: splitDirection,
      trader_payout_wallet_address: null,
      active: true,
    })
    .select('*')
    .single();

  if (error || !agreement) return apiError('INTERNAL_ERROR', 'Could not create this payout agreement.');

  return apiSuccess({ agreement }, 201);
}
