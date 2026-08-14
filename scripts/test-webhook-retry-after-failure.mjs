// Week 3 Thursday (webhook reliability check) — direct integration proof
// for the fix in 20260724000002_fix_webhook_idempotency_on_partial_failure.sql:
// a webhook retry after a prior attempt that never finished must actually
// reprocess (not be silently swallowed as a "duplicate"), while a retry
// after a prior attempt that genuinely completed must still be skipped.
//
// Calls the REAL Stripe webhook route handler against shadow — not a
// reimplementation, not a mock of the route itself (only the DB target
// is redirected to shadow, same technique test-billing-cycle.mjs uses).
//
// Usage: npx tsx scripts/test-webhook-retry-after-failure.mjs
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const SHADOW_SUPABASE_URL = process.env.SHADOW_SUPABASE_URL;
const SHADOW_SERVICE_ROLE_KEY = process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!SHADOW_SUPABASE_URL || !SHADOW_SERVICE_ROLE_KEY) {
  console.error('Missing SHADOW_SUPABASE_URL / SHADOW_SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
  console.error('STRIPE_SECRET_KEY is not a TEST key — refusing to run against a non-test key.');
  process.exit(1);
}

const TEST_WEBHOOK_SECRET = 'whsec_test_local_retry_check_' + crypto.randomBytes(8).toString('hex');
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-06-24.dahlia' });
const shadowAdmin = createClient(SHADOW_SUPABASE_URL, SHADOW_SERVICE_ROLE_KEY);

let failures = 0;
function report(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

async function withShadowAsLive(fn) {
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SHADOW_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SHADOW_SERVICE_ROLE_KEY;
  try {
    return await fn();
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
}

async function createTestUser(email) {
  const { data, error } = await shadowAdmin.auth.admin.createUser({
    email,
    password: 'BillingTest!2026x',
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function deleteTestUser(userId) {
  await shadowAdmin.auth.admin.deleteUser(userId).catch(() => {});
}

async function getSubscriptionRow(userId) {
  const { data } = await shadowAdmin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function stripeEventRequest(event) {
  const { POST } = await import('../src/app/api/webhooks/stripe/route.ts');
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });
  const { NextRequest } = await import('next/server');
  const request = new NextRequest('https://vaultpoint.name.ng/api/webhooks/stripe', {
    method: 'POST',
    body: payload,
    headers: { 'stripe-signature': signature },
  });
  return withShadowAsLive(() => POST(request));
}

async function main() {
  console.log('=== Retry after a FAILED prior attempt must reprocess, not be swallowed ===');
  const priceId = process.env.STRIPE_PRICE_PRO;
  const userId = await createTestUser(`webhook-retry-test-${Date.now()}@example.invalid`);
  const eventId = `evt_test_retry_${Date.now()}`;

  try {
    const customer = await stripe.customers.create({ email: `webhook-retry-test-${Date.now()}@example.invalid` });
    const paymentMethod = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      default_payment_method: paymentMethod.id,
    });

    const event = {
      id: eventId,
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: userId, subscription: subscription.id, customer: customer.id } },
    };

    // Simulate attempt #1 having claimed the event, then crashed/failed
    // partway through — exactly the state a real transient DB error
    // would leave behind (this is what the bug report calls "the row
    // exists but was never marked completed").
    const { error: seedError } = await shadowAdmin.from('billing_webhook_events').insert({
      provider: 'stripe',
      event_id: eventId,
      event_type: event.type,
      metadata: {},
      status: 'failed',
    });
    if (seedError) throw new Error(`Could not seed failed webhook_events row: ${seedError.message}`);

    let subRowBefore = await getSubscriptionRow(userId);
    report('no subscription row exists yet (attempt #1 never actually applied anything)', subRowBefore === null);

    // Attempt #2: the real retry Stripe would send for the same event id.
    const response = await stripeEventRequest(event);
    const body = await response.json();

    report('retry is accepted (200), not rejected', response.status === 200, `status=${response.status}`);
    report('retry is NOT marked as a duplicate — it actually reprocessed', body.duplicate !== true, JSON.stringify(body));

    const subRowAfter = await getSubscriptionRow(userId);
    report(
      'subscription row now exists with tier=pro — the retry actually applied the update',
      subRowAfter?.tier === 'pro',
      JSON.stringify(subRowAfter)
    );

    const { data: eventRow } = await shadowAdmin
      .from('billing_webhook_events')
      .select('status')
      .eq('provider', 'stripe')
      .eq('event_id', eventId)
      .single();
    report('webhook_events row now shows status=completed', eventRow?.status === 'completed', JSON.stringify(eventRow));
  } finally {
    await deleteTestUser(userId);
    await shadowAdmin.from('billing_webhook_events').delete().eq('provider', 'stripe').eq('event_id', eventId);
  }

  console.log('\n=== Retry after a COMPLETED prior attempt must still be skipped (real duplicate) ===');
  const userId2 = await createTestUser(`webhook-retry-dup-test-${Date.now()}@example.invalid`);
  const eventId2 = `evt_test_dup_${Date.now()}`;
  try {
    const customer = await stripe.customers.create({ email: `webhook-retry-dup-test-${Date.now()}@example.invalid` });
    const paymentMethod = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      default_payment_method: paymentMethod.id,
    });

    const event = {
      id: eventId2,
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: userId2, subscription: subscription.id, customer: customer.id } },
    };

    const first = await stripeEventRequest(event);
    report('first delivery accepted', first.status === 200);
    const afterFirst = await getSubscriptionRow(userId2);
    report('first delivery actually created the subscription', afterFirst?.tier === 'pro');

    const second = await stripeEventRequest(event);
    const secondBody = await second.json();
    report('second (genuine) delivery of the same completed event is marked duplicate', secondBody.duplicate === true, JSON.stringify(secondBody));
  } finally {
    await deleteTestUser(userId2);
    await shadowAdmin.from('billing_webhook_events').delete().eq('provider', 'stripe').eq('event_id', eventId2);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll webhook retry-reliability checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
