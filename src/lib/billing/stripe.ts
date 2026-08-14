import Stripe from 'stripe';

/**
 * Lazily-constructed singleton, same pattern as
 * src/lib/encryption/broker-keys.ts's getEncryptionKey(): read the env var
 * per call rather than at module load, so a route that never touches
 * billing doesn't crash at import time in an environment without
 * STRIPE_SECRET_KEY set (e.g. a build step, or a deployment that only
 * serves NGN/Paystack traffic).
 */
let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Check .env.local against .env.example.');
  }

  stripeClient = new Stripe(secretKey, {
    apiVersion: '2026-06-24.dahlia',
    typescript: true,
  });
  return stripeClient;
}

export function getStripePriceId(tier: 'pro' | 'elite'): string {
  const envVar = tier === 'pro' ? 'STRIPE_PRICE_PRO' : 'STRIPE_PRICE_ELITE';
  const priceId = process.env[envVar];
  if (!priceId) {
    throw new Error(`${envVar} is not set. Check .env.local against .env.example.`);
  }
  return priceId;
}

/** Inverse of getStripePriceId — used by the webhook to map a Stripe
 * subscription's price back to our internal tier. Returns null for a
 * price that matches neither configured tier (shouldn't happen for our
 * own products, but a webhook handler should never throw on unexpected
 * provider data). */
export function tierFromStripePriceId(priceId: string): 'pro' | 'elite' | null {
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_ELITE) return 'elite';
  return null;
}

/**
 * Creates a one-off PaymentIntent for a wallet deposit — unlike the
 * subscription checkout flow, there's no Price/Plan object, just a raw
 * amount in the smallest currency unit (cents). metadata.purpose is set to
 * 'wallet_deposit' so the webhook's payment_intent.succeeded case (a
 * previously-unhandled event type — no collision with the subscription
 * event types already handled) can identify it.
 */
export async function createDepositPaymentIntent(params: {
  userId: string;
  amountCents: number;
  currency: string;
}): Promise<{ clientSecret: string; paymentIntentId: string }> {
  const paymentIntent = await getStripeClient().paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency.toLowerCase(),
    metadata: { user_id: params.userId, purpose: 'wallet_deposit' },
  });

  if (!paymentIntent.client_secret) {
    throw new Error('Stripe did not return a client_secret for the deposit PaymentIntent.');
  }

  return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
}

/**
 * Placeholder for a Stripe-rail wallet withdrawal payout. A real payout
 * requires a Stripe Connected Account for the destination (Stripe has no
 * concept of paying an arbitrary bank account without one) — this repo has
 * no Connect integration configured yet, so this throws rather than
 * silently no-op, until that infrastructure decision is made (same
 * "explicitly not wired to a real rail yet" treatment as the crypto payout
 * adapter and managed_accounts' existing manual withdrawal flow).
 */
export async function createStripePayout(_params: {
  amountCents: number;
  currency: string;
  destinationDetails: Record<string, string>;
}): Promise<never> {
  throw new Error(
    'Stripe withdrawal payouts are not yet wired to a real rail — requires a Stripe Connected Account decision before this can execute a real payout.'
  );
}
