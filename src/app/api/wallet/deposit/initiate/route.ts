import { randomUUID } from 'crypto';
import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { depositInitiateSchema } from '@/lib/validations/wallet';
import { checkWalletLimit } from '@/lib/wallet/limits';
import { checkKycTierLimit } from '@/lib/kyc/wallet-tier-limit-check';
import { resolveWalletProvider, CURRENCY_BY_WALLET_PROVIDER, type WalletProvider } from '@/lib/wallet/routing';
import { initializePaystackDeposit } from '@/lib/billing/paystack';
import { createDepositPaymentIntent } from '@/lib/billing/stripe';
import { getOrCreateDepositAddress } from '@/lib/wallet/web3-adapter';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/wallet/deposit/initiate
 *
 * Resolves a rail (explicit choice, or NGN->Paystack/else->Stripe via
 * resolveWalletProvider) and kicks off that rail's checkout. No
 * wallet_transactions row is created here — wallet_apply_transaction()
 * only ever inserts a *completed* row, fired by the provider webhook once
 * the deposit is actually confirmed (see
 * src/app/api/webhooks/paystack/route.ts, .../stripe/route.ts,
 * .../web3/route.ts), same "never trust the client, wait for the
 * provider" rule as every other billing flow in this codebase.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = depositInitiateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid deposit request.', parsed.error.flatten());
  }
  const { amount, currency, provider: explicitProvider } = parsed.data;

  const limitCheck = checkWalletLimit(currency, amount);
  if (!limitCheck.ok) {
    return apiError('LIMIT_EXCEEDED', limitCheck.message);
  }

  // KYC tier gate — reasonCode 'withdrawals_not_allowed_for_tier' never
  // fires here (type is always 'deposit'), kept symmetric with the same
  // check in withdraw/request/route.ts. 422 (LIMIT_EXCEEDED), not the PRD's
  // literal 400, to match this codebase's existing status convention.
  const tierCheck = await checkKycTierLimit({ userId: authData.user.id, type: 'deposit', amount, currency });
  if (!tierCheck.allowed) {
    return apiError(
      tierCheck.reasonCode === 'withdrawals_not_allowed_for_tier' ? 'KYC_REQUIRED' : 'LIMIT_EXCEEDED',
      tierCheck.message
    );
  }

  const { data: profile } = await supabase.from('users').select('country_code').eq('id', authData.user.id).single();

  const resolvedProvider = resolveWalletProvider({
    country: profile?.country_code,
    explicitProvider: explicitProvider as WalletProvider | undefined,
  });

  if (CURRENCY_BY_WALLET_PROVIDER[resolvedProvider] !== currency) {
    return apiError(
      'VALIDATION_ERROR',
      `${resolvedProvider} deposits settle in ${CURRENCY_BY_WALLET_PROVIDER[resolvedProvider]}, not ${currency}.`
    );
  }

  const reference = `wallet_deposit_${randomUUID()}`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    if (resolvedProvider === 'paystack') {
      if (!authData.user.email) {
        return apiError('VALIDATION_ERROR', 'An email address is required to deposit.');
      }
      const { url, reference: paystackReference } = await initializePaystackDeposit({
        email: authData.user.email,
        userId: authData.user.id,
        amountKobo: Math.round(amount * 100),
        reference,
        callbackUrl: `${appUrl}/dashboard/wallet?deposit=success`,
      });
      return apiSuccess({ provider: 'paystack', url, reference: paystackReference });
    }

    if (resolvedProvider === 'stripe') {
      const { clientSecret, paymentIntentId } = await createDepositPaymentIntent({
        userId: authData.user.id,
        amountCents: Math.round(amount * 100),
        currency,
      });
      return apiSuccess({ provider: 'stripe', clientSecret, paymentIntentId });
    }

    const { address, chain } = await getOrCreateDepositAddress(authData.user.id);
    return apiSuccess({ provider: 'crypto', address, chain, expectedAmount: amount, currency });
  } catch (err) {
    console.error('wallet/deposit/initiate provider error:', err);
    return apiError('PAYMENT_ERROR', 'Could not start deposit. Please try again.');
  }
}
