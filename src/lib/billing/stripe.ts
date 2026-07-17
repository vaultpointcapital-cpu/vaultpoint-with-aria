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
