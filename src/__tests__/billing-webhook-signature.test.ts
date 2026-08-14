import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import Stripe from 'stripe';

const PAYSTACK_TEST_SECRET = 'sk_test_paystack_fixture_key_do_not_use';

describe('verifyPaystackSignature', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = PAYSTACK_TEST_SECRET;
  });

  it('accepts a valid HMAC-SHA512 signature over the exact raw body', async () => {
    const { verifyPaystackSignature } = await import('@/lib/billing/paystack');
    const rawBody = JSON.stringify({ event: 'charge.success', data: { id: 1 } });
    const signature = crypto.createHmac('sha512', PAYSTACK_TEST_SECRET).update(rawBody).digest('hex');

    expect(verifyPaystackSignature(rawBody, signature)).toBe(true);
  });

  it('rejects a signature computed over a tampered body', async () => {
    const { verifyPaystackSignature } = await import('@/lib/billing/paystack');
    const originalBody = JSON.stringify({ event: 'charge.success', data: { id: 1 } });
    const signature = crypto.createHmac('sha512', PAYSTACK_TEST_SECRET).update(originalBody).digest('hex');

    const tamperedBody = JSON.stringify({ event: 'charge.success', data: { id: 999 } });

    expect(verifyPaystackSignature(tamperedBody, signature)).toBe(false);
  });

  it('rejects when the signature header is missing', async () => {
    const { verifyPaystackSignature } = await import('@/lib/billing/paystack');
    const rawBody = JSON.stringify({ event: 'charge.success', data: { id: 1 } });

    expect(verifyPaystackSignature(rawBody, null)).toBe(false);
  });

  it('rejects a signature of the wrong length rather than throwing', async () => {
    const { verifyPaystackSignature } = await import('@/lib/billing/paystack');
    const rawBody = JSON.stringify({ event: 'charge.success', data: { id: 1 } });

    expect(verifyPaystackSignature(rawBody, 'not-a-real-signature')).toBe(false);
  });
});

describe('Stripe webhook signature verification', () => {
  // Exercises our actual usage of stripe.webhooks.constructEvent — the
  // verification logic itself lives in the Stripe SDK, but this confirms
  // our route's call pattern (secret, header, payload) rejects tampering
  // and a missing/invalid header the same way Paystack's does.
  const webhookSecret = 'whsec_test_fixture_do_not_use';
  const stripe = new Stripe('sk_test_fixture_not_a_real_key', { apiVersion: '2026-06-24.dahlia', typescript: true });

  it('accepts an event with a valid signature', () => {
    const payload = JSON.stringify({ id: 'evt_test123', type: 'checkout.session.completed' });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    const event = stripe.webhooks.constructEvent(payload, header, webhookSecret);
    expect(event.id).toBe('evt_test123');
  });

  it('rejects a payload that was tampered with after signing', () => {
    const payload = JSON.stringify({ id: 'evt_test123', type: 'checkout.session.completed' });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const tamperedPayload = JSON.stringify({ id: 'evt_test123', type: 'customer.subscription.deleted' });

    expect(() => stripe.webhooks.constructEvent(tamperedPayload, header, webhookSecret)).toThrow();
  });

  it('rejects a missing signature header', () => {
    const payload = JSON.stringify({ id: 'evt_test123', type: 'checkout.session.completed' });

    expect(() => stripe.webhooks.constructEvent(payload, '', webhookSecret)).toThrow();
  });
});
