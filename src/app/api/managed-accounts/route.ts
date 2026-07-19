import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/encryption/broker-keys';
import {
  provisionManagedAccountSchema,
  isEligibleForManagedTier,
  MANAGED_TIER_TERMS,
} from '@/lib/validations/managed-accounts';
import { createNotification } from '@/lib/managed-accounts/notifications';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/managed-accounts
 * Lists the authenticated user's managed accounts.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('managed_accounts')
    .select(
      'id, tier, profit_split_pct, max_drawdown_pct, withdrawal_window_cadence, next_withdrawal_window_date, kyc_status, kyc_verified_at, broker, status, starting_capital, current_balance, requires_disclosure_reconfirmation, created_at'
    )
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load managed accounts.');
  }

  return apiSuccess({ managedAccounts: data });
}

/**
 * POST /api/managed-accounts
 * Step 5 of onboarding — sub-account provisioning. Restricted to
 * MetaTrader only (see provisionManagedAccountSchema's comment for
 * why). Requires a signed client_authorizations row to already exist —
 * a client cannot reach this step without step 4 completed, enforced
 * here AND at the DB level by managed_accounts_funding_requires_authorization
 * (that constraint only blocks pending_funding/active, not the initial
 * pending_kyc insert, so this check is the real gate for this step).
 *
 * Deliberately does NOT call MetaApi's provisioning API here — that
 * requires either extending the Python broker-sync poller to also scan
 * managed_accounts (it currently only polls broker_connections) or a
 * dedicated endpoint, neither of which exists yet. This route creates
 * the row with encrypted credentials and metaapi_account_id/region left
 * null; actual account creation+deployment is real follow-up work, not
 * silently assumed to happen.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = provisionManagedAccountSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid managed account request.', parsed.error.flatten());
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  if (!isEligibleForManagedTier(profile?.subscription_tier ?? 'free', parsed.data.tier)) {
    return apiError('FORBIDDEN', `Your subscription plan does not unlock the ${parsed.data.tier} Managed Tier.`);
  }

  const { data: authorization } = await supabase
    .from('client_authorizations')
    .select('id')
    .eq('user_id', authData.user.id)
    .is('revoked_at', null)
    .order('signed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!authorization) {
    return apiError(
      'VALIDATION_ERROR',
      'You must complete the risk disclosure and sign the trading authorization before provisioning an account.'
    );
  }

  const terms = MANAGED_TIER_TERMS[parsed.data.tier];
  const encryptedMtPassword = encrypt(parsed.data.mtPassword);

  const { data, error } = await supabase
    .from('managed_accounts')
    .insert({
      user_id: authData.user.id,
      tier: parsed.data.tier,
      profit_split_pct: terms.profitSplitPct,
      max_drawdown_pct: terms.maxDrawdownPct,
      withdrawal_window_cadence: terms.withdrawalWindowCadence,
      next_withdrawal_window_date: null,
      client_authorization_id: authorization.id,
      kyc_status: 'pending',
      kyc_verified_at: null,
      broker: 'metatrader',
      encrypted_api_key: null,
      api_key_iv: null,
      encrypted_api_secret: null,
      api_secret_iv: null,
      mt_login: parsed.data.mtLogin,
      mt_server: parsed.data.mtServer,
      mt_platform: parsed.data.mtPlatform,
      encrypted_mt_password: encryptedMtPassword.ciphertext,
      mt_password_iv: encryptedMtPassword.iv,
      metaapi_account_id: null,
      metaapi_region: null,
      status: 'pending_kyc',
      starting_capital: null,
      current_balance: null,
      requires_disclosure_reconfirmation: false,
    })
    .select(
      'id, tier, profit_split_pct, max_drawdown_pct, withdrawal_window_cadence, kyc_status, broker, status, created_at'
    )
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not create your managed account.');
  }

  await createNotification(supabase, {
    userId: authData.user.id,
    managedAccountId: data.id,
    type: 'onboarding_milestone',
    title: 'Managed account created',
    body: `Your ${parsed.data.tier} Managed Account has been created and is pending KYC verification.`,
  });

  return apiSuccess({ managedAccount: data }, 201);
}
