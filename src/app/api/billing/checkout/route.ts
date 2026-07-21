import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkoutSchema, TIER_RANK } from '@/lib/validations/billing';
import { resolveProvider } from '@/lib/billing/routing';
import { getStripeClient, getStripePriceId } from '@/lib/billing/stripe';
import { getPaystackPlanCode, initializePaystackTransaction } from '@/lib/billing/paystack';
import { initializeFlutterwaveTransaction } from '@/lib/billing/flutterwave';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json();
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid checkout request.', parsed.error.flatten());
  }
  const { tier, preferred_provider } = parsed.data;

  const { data: profile } = await supabase
    .from('users')
    .select('country_code')
    .eq('id', authData.user.id)
    .single();

  const { data: existingSubscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', authData.user.id)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSubscription && TIER_RANK[existingSubscription.tier] >= TIER_RANK[tier]) {
    return apiError(
      'VALIDATION_ERROR',
      `You already have an active ${existingSubscription.tier} subscription.`,
      { currentTier: existingSubscription.tier, requestedTier: tier }
    );
  }

  const provider = resolveProvider({ country: profile?.country_code, preferredProvider: preferred_provider });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    if (provider === 'stripe') {
      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: authData.user.id,
        customer_email: authData.user.email,
        line_items: [{ price: getStripePriceId(tier), quantity: 1 }],
        success_url: `${appUrl}/settings/billing?status=success`,
        cancel_url: `${appUrl}/settings/billing?status=cancelled`,
      });

      if (!session.url) {
        return apiError('PAYMENT_ERROR', 'Stripe did not return a checkout URL.');
      }
      return apiSuccess({ url: session.url });
    }

    if (!authData.user.email) {
      return apiError('VALIDATION_ERROR', 'An email address is required to check out.');
    }

    if (provider === 'flutterwave') {
      const { url } = await initializeFlutterwaveTransaction({
        email: authData.user.email,
        tier,
        userId: authData.user.id,
        redirectUrl: `${appUrl}/settings/billing?status=success`,
      });
      return apiSuccess({ url });
    }

    const { url } = await initializePaystackTransaction({
      email: authData.user.email,
      planCode: getPaystackPlanCode(tier),
      userId: authData.user.id,
      callbackUrl: `${appUrl}/settings/billing?status=success`,
    });
    return apiSuccess({ url });
  } catch (err) {
    // Never leak provider error internals (may include request details) —
    // log server-side, return the generic shape per dev rule #6.
    console.error('billing/checkout provider error:', err);
    return apiError('PAYMENT_ERROR', 'Could not start checkout. Please try again.');
  }
}
