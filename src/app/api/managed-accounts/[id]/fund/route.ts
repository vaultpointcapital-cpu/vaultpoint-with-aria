import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { fundManagedAccountSchema } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/:id/fund
 * Step 6 of onboarding — funding. The spec's own flow has the client
 * deposit capital directly into their segregated sub-account via
 * existing payment rails (Paystack/Stripe/Flutterwave), never into a
 * VaultPoint-held account — but no custodian deposit-confirmation API
 * is integrated anywhere in this codebase to verify that actually
 * happened. This route is a SELF-REPORTED confirmation only: the
 * client states their starting capital, and this sets status to
 * 'active' (gated by managed_accounts_active_requires_kyc — it will
 * reject if KYC isn't verified yet, regardless of this route's own
 * logic). Real deposit verification against the broker/custodian is
 * flagged as a genuine gap, not silently assumed to happen.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = fundManagedAccountSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid funding request.', parsed.error.flatten());
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, kyc_status, client_authorization_id, status')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  if (account.kyc_status !== 'verified') {
    return apiError('VALIDATION_ERROR', 'KYC must be verified before this account can be funded.');
  }

  const { data, error } = await supabase
    .from('managed_accounts')
    .update({
      starting_capital: parsed.data.startingCapital,
      current_balance: parsed.data.startingCapital,
      status: 'active',
    })
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select('id, status, starting_capital, current_balance')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not confirm funding for this account.');
  }

  return apiSuccess({ managedAccount: data });
}
