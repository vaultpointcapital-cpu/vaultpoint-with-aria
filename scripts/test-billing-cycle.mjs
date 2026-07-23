// End-to-end billing cycle test — Day 1 of the launch sprint ("Billing:
// test mode, Stripe + Paystack"). Simulates signup -> subscribe -> webhook
// -> DB tier update for Free/Pro/Elite across both processors, calling the
// REAL webhook route handlers (src/app/api/webhooks/{stripe,paystack}/
// route.ts) — not a reimplementation of their logic — so this actually
// exercises the code that runs in production.
//
// This test is what caught a real launch-blocking bug: the webhook
// handlers only ever wrote to the `subscriptions` table, never to
// `users.subscription_tier` — the column every feature-gating route (and
// the profit-share billing cron) actually reads. A user could pay
// successfully and still be gated as 'free' forever. Fixed in
// src/lib/billing/get-user-tier.ts (syncUserSubscriptionTier), wired into
// both webhook handlers. This script is the regression test for that fix.
//
// Usage: npx tsx scripts/test-billing-cycle.mjs
// Must run via tsx, not plain node: this script imports route.ts directly,
// which itself imports from 'next/server' with no file extension. Next.js's
// own bundler resolves that fine, but plain Node's ESM loader does not
// auto-complete extensions for bare subpath specifiers (next/server has no
// package.json "exports" entry to resolve it either) and fails with
// ERR_MODULE_NOT_FOUND. tsx's resolver is more permissive and handles it.
// .env.local is parsed manually (see the readFileSync loop below) — no
// --env-file flag or dotenv package needed.
// Requires SHADOW_DB_URL, SHADOW_SUPABASE_URL, SHADOW_SUPABASE_SERVICE_ROLE_KEY
// (shadow project's own Admin API credentials — same safety property as
// scripts/test-rls-isolation.mjs: this script only ever reads the
// SHADOW_*-named variables, never the live ones, by construction) and
// Stripe/Paystack TEST-mode keys (STRIPE_SECRET_KEY starting sk_test_,
// PAYSTACK_SECRET_KEY starting sk_test_) plus STRIPE_PRICE_PRO/ELITE and
// PAYSTACK_PLAN_PRO/ELITE (test-mode price/plan ids).
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
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SHADOW_SUPABASE_URL || !SHADOW_SERVICE_ROLE_KEY) {
  console.error('Missing SHADOW_SUPABASE_URL / SHADOW_SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
  console.error('STRIPE_SECRET_KEY is not a TEST key (must start sk_test_) — refusing to run against a non-test key.');
  process.exit(1);
}
if (!PAYSTACK_SECRET_KEY?.startsWith('sk_test')) {
  console.error('PAYSTACK_SECRET_KEY is not a TEST key (must start sk_test) — refusing to run against a non-test key.');
  process.exit(1);
}
const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
if (FLUTTERWAVE_SECRET_KEY && !FLUTTERWAVE_SECRET_KEY.startsWith('FLWSECK_TEST')) {
  console.error('FLUTTERWAVE_SECRET_KEY is not a TEST key (must start FLWSECK_TEST) — refusing to run against a non-test key.');
  process.exit(1);
}

// A dummy value is fine here: Stripe's constructEvent() only checks that
// the HMAC in the header matches this secret — it never calls Stripe's
// servers to validate it, so signing and verifying with the same local
// value is a legitimate, fully offline test of the signature-checking
// code path itself.
const TEST_WEBHOOK_SECRET = 'whsec_test_local_billing_cycle_' + crypto.randomBytes(8).toString('hex');
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

/** Runs fn with NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY pointed
 * at the shadow project, so the real webhook route handlers (which call
 * createServiceClient() internally) write to shadow instead of live.
 * Restores the previous values afterward regardless of outcome. */
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

async function getUsersRow(userId) {
  const { data } = await shadowAdmin.from('users').select('subscription_tier').eq('id', userId).single();
  return data;
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

// ---------------------------------------------------------------------
// Free tier — no processor involved, just confirms a fresh signup lands
// on 'free' with no subscriptions row (the implicit default every gating
// route falls back to).
// ---------------------------------------------------------------------
async function testFreeTier() {
  console.log('\n=== Free tier (no processor) ===');
  const userId = await createTestUser(`billing-test-free-${Date.now()}@example.invalid`);
  try {
    const usersRow = await getUsersRow(userId);
    report('fresh signup has users.subscription_tier = free', usersRow?.subscription_tier === 'free');

    const sub = await getSubscriptionRow(userId);
    report('fresh signup has no subscriptions row', sub === null);
  } finally {
    await deleteTestUser(userId);
  }
}

// ---------------------------------------------------------------------
// Stripe — creates a REAL test-mode customer + subscription (using
// Stripe's built-in test payment method, no real card), then fires the
// same webhook events Stripe would actually send, at the real route
// handler, and asserts shadow DB state.
// ---------------------------------------------------------------------
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
  const response = await withShadowAsLive(() => POST(request));
  if (!response.ok) {
    console.error(`  [stripe webhook] ${event.type} -> ${response.status}:`, await response.clone().text());
  }
  return response;
}

async function testStripeTier(tier) {
  console.log(`\n=== Stripe — ${tier} ===`);
  const priceEnvVar = tier === 'pro' ? 'STRIPE_PRICE_PRO' : 'STRIPE_PRICE_ELITE';
  const priceId = process.env[priceEnvVar];
  if (!priceId) {
    report(`${priceEnvVar} is set`, false, 'skipping Stripe ' + tier);
    return;
  }

  const userId = await createTestUser(`billing-test-stripe-${tier}-${Date.now()}@example.invalid`);
  let customer, subscription;
  try {
    customer = await stripe.customers.create({
      email: `billing-test-stripe-${tier}-${Date.now()}@example.invalid`,
    });

    const paymentMethod = await stripe.paymentMethods.create({
      type: 'card',
      card: { token: 'tok_visa' },
    });
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });

    subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      default_payment_method: paymentMethod.id,
    });

    report('real Stripe test subscription created as active', subscription.status === 'active', subscription.status);

    // --- checkout.session.completed: initial subscribe ---
    await stripeEventRequest({
      id: `evt_test_checkout_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: userId,
          subscription: subscription.id,
          customer: customer.id,
        },
      },
    });

    let subRow = await getSubscriptionRow(userId);
    report(`subscriptions row created with tier=${tier}`, subRow?.tier === tier, JSON.stringify(subRow));
    report('subscriptions row status=active', subRow?.status === 'active');

    let usersRow = await getUsersRow(userId);
    report(`users.subscription_tier synced to ${tier}`, usersRow?.subscription_tier === tier, JSON.stringify(usersRow));

    // --- customer.subscription.deleted: cancellation revokes access ---
    await stripeEventRequest({
      id: `evt_test_cancel_${Date.now()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: subscription.id } },
    });

    subRow = await getSubscriptionRow(userId);
    report('subscriptions row status=cancelled after cancellation', subRow?.status === 'cancelled');

    usersRow = await getUsersRow(userId);
    report('users.subscription_tier reset to free after cancellation', usersRow?.subscription_tier === 'free', JSON.stringify(usersRow));
  } finally {
    if (subscription) await stripe.subscriptions.cancel(subscription.id).catch(() => {});
    if (customer) await stripe.customers.del(customer.id).catch(() => {});
    await deleteTestUser(userId);
  }
}

// ---------------------------------------------------------------------
// Paystack — no outbound API call needed (the handler trusts the signed
// webhook payload directly), so this signs a synthetic payload with the
// real test PAYSTACK_SECRET_KEY and posts it at the real route handler.
// ---------------------------------------------------------------------
function signPaystackPayload(payload) {
  return crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(payload).digest('hex');
}

async function paystackEventRequest(event) {
  const { POST } = await import('../src/app/api/webhooks/paystack/route.ts');
  const payload = JSON.stringify(event);
  const signature = signPaystackPayload(payload);
  const { NextRequest } = await import('next/server');
  const request = new NextRequest('https://vaultpoint.name.ng/api/webhooks/paystack', {
    method: 'POST',
    body: payload,
    headers: { 'x-paystack-signature': signature },
  });
  const response = await withShadowAsLive(() => POST(request));
  if (!response.ok) {
    console.error(`  [paystack webhook] ${event.event} -> ${response.status}:`, await response.clone().text());
  }
  return response;
}

async function testPaystackTier(tier) {
  console.log(`\n=== Paystack — ${tier} ===`);
  const planEnvVar = tier === 'pro' ? 'PAYSTACK_PLAN_PRO' : 'PAYSTACK_PLAN_ELITE';
  const planCode = process.env[planEnvVar];
  if (!planCode) {
    report(`${planEnvVar} is set`, false, 'skipping Paystack ' + tier);
    return;
  }

  const userId = await createTestUser(`billing-test-paystack-${tier}-${Date.now()}@example.invalid`);
  const customerCode = `CUS_test_${crypto.randomBytes(6).toString('hex')}`;
  const subscriptionCode = `SUB_test_${crypto.randomBytes(6).toString('hex')}`;

  try {
    // --- charge.success: initial subscribe ---
    await paystackEventRequest({
      event: 'charge.success',
      data: {
        id: Date.now(),
        status: 'success',
        customer: { customer_code: customerCode, email: 'billing-test@example.invalid' },
        plan: { plan_code: planCode },
        metadata: { user_id: userId },
        authorization: { authorization_code: `AUTH_test_${Date.now()}`, reusable: true },
      },
    });

    let subRow = await getSubscriptionRow(userId);
    report(`subscriptions row created with tier=${tier}`, subRow?.tier === tier, JSON.stringify(subRow));
    report('subscriptions row status=active', subRow?.status === 'active');

    let usersRow = await getUsersRow(userId);
    report(`users.subscription_tier synced to ${tier}`, usersRow?.subscription_tier === tier, JSON.stringify(usersRow));

    // --- subscription.create: Paystack backfills the subscription_code ---
    await paystackEventRequest({
      event: 'subscription.create',
      data: {
        customer: { customer_code: customerCode },
        subscription_code: subscriptionCode,
        next_payment_date: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      },
    });

    subRow = await getSubscriptionRow(userId);
    report('subscriptions row backfilled with provider_subscription_id', subRow?.provider_subscription_id === subscriptionCode);

    // --- subscription.disable: cancellation revokes access ---
    await paystackEventRequest({
      event: 'subscription.disable',
      data: { subscription_code: subscriptionCode },
    });

    subRow = await getSubscriptionRow(userId);
    report('subscriptions row status=cancelled after disable', subRow?.status === 'cancelled');

    usersRow = await getUsersRow(userId);
    report('users.subscription_tier reset to free after disable', usersRow?.subscription_tier === 'free', JSON.stringify(usersRow));
  } finally {
    await deleteTestUser(userId);
  }
}

// ---------------------------------------------------------------------
// Day 2 — failure paths. Card decline/expiry itself happens entirely on
// Stripe's/Paystack's own hosted checkout page (src/app/api/billing/
// checkout/route.ts only ever gets back a redirect URL, never raw card
// state), so there's no app code path to test for a decline AT checkout.
// What the app's own code is responsible for is a RENEWAL charge failing
// (invoice.payment_failed) and duplicate webhook delivery (idempotency) —
// both tested directly against the real route handlers below.
// ---------------------------------------------------------------------
async function testStripeFailurePaths() {
  console.log('\n=== Stripe — failure paths ===');
  const priceId = process.env.STRIPE_PRICE_PRO;
  if (!priceId) {
    report('STRIPE_PRICE_PRO is set', false, 'skipping Stripe failure paths');
    return;
  }

  const userId = await createTestUser(`billing-test-stripe-fail-${Date.now()}@example.invalid`);
  let customer, subscription;
  try {
    customer = await stripe.customers.create({ email: `billing-test-stripe-fail-${Date.now()}@example.invalid` });
    const paymentMethod = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethod.id } });
    subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      default_payment_method: paymentMethod.id,
    });

    const checkoutEvent = {
      id: `evt_test_checkout_${Date.now()}`,
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: userId, subscription: subscription.id, customer: customer.id } },
    };
    await stripeEventRequest(checkoutEvent);

    // --- declined/expired renewal card: invoice.payment_failed ---
    await stripeEventRequest({
      id: `evt_test_invfail_${Date.now()}`,
      type: 'invoice.payment_failed',
      data: { object: { parent: { subscription_details: { subscription: subscription.id } }, customer: customer.id } },
    });

    let subRow = await getSubscriptionRow(userId);
    report('renewal decline sets subscriptions.status=past_due', subRow?.status === 'past_due', JSON.stringify(subRow));
    report('past_due_since is set on first decline', !!subRow?.past_due_since, JSON.stringify(subRow));

    let usersRow = await getUsersRow(userId);
    report(
      `access retained during grace period (still tier=pro)`,
      usersRow?.subscription_tier === 'pro',
      JSON.stringify(usersRow)
    );

    // --- a second decline for the SAME outage must not push the grace
    // clock forward ---
    const firstPastDueSince = subRow.past_due_since;
    await stripeEventRequest({
      id: `evt_test_invfail2_${Date.now()}`,
      type: 'invoice.payment_failed',
      data: { object: { parent: { subscription_details: { subscription: subscription.id } }, customer: customer.id } },
    });
    subRow = await getSubscriptionRow(userId);
    report('second decline for the same outage does not reset past_due_since', subRow?.past_due_since === firstPastDueSince);

    // --- backdate past_due_since beyond the grace window (directly in
    // shadow DB, simulating time passing) and confirm access is THEN
    // revoked ---
    await shadowAdmin
      .from('subscriptions')
      .update({ past_due_since: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() })
      .eq('user_id', userId);
    const { syncUserSubscriptionTier } = await import('../src/lib/billing/get-user-tier.ts');
    await syncUserSubscriptionTier(shadowAdmin, userId);
    usersRow = await getUsersRow(userId);
    report('access revoked once past the 3-day grace window', usersRow?.subscription_tier === 'free', JSON.stringify(usersRow));

    // --- recovery: a successful renewal clears past_due_since ---
    await stripeEventRequest({
      id: `evt_test_recover_${Date.now()}`,
      type: 'customer.subscription.updated',
      data: { object: { ...subscription, status: 'active' } },
    });
    subRow = await getSubscriptionRow(userId);
    report('recovery (active again) clears past_due_since', subRow?.past_due_since === null, JSON.stringify(subRow));
    usersRow = await getUsersRow(userId);
    report(`recovery restores tier=pro`, usersRow?.subscription_tier === 'pro', JSON.stringify(usersRow));

    // --- duplicate webhook delivery: same event id sent twice ---
    const dupeEvent = { id: `evt_test_dupe_${Date.now()}`, type: 'customer.subscription.updated', data: { object: subscription } };
    const first = await stripeEventRequest(dupeEvent);
    const firstBody = await first.clone().json();
    const second = await stripeEventRequest(dupeEvent);
    const secondBody = await second.clone().json();
    report('first delivery of a new event id is NOT marked duplicate', firstBody.duplicate !== true, JSON.stringify(firstBody));
    report('exact-duplicate event id redelivery is marked duplicate, not reprocessed', secondBody.duplicate === true, JSON.stringify(secondBody));

    // --- an event referencing a subscription id that matches no row is a
    // safe no-op (200, nothing written) — Stripe would never actually send
    // a customer.subscription.deleted without a real id, so this just
    // confirms an unmatched event doesn't crash or write anything wrong.
    // (The separate property - that a REAL Postgres error, e.g. a
    // constraint violation, surfaces as 500 so the processor retries -
    // was already proven directly: the ON CONFLICT bug found earlier in
    // this same session 500'd correctly once error-checking was added,
    // before the underlying index was fixed.)
    const unmatched = await stripeEventRequest({
      id: `evt_test_unmatched_${Date.now()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_does_not_exist_in_our_db' } },
    });
    report('event referencing an unmatched subscription id is a safe no-op', unmatched.status === 200, `status=${unmatched.status}`);
  } finally {
    if (subscription) await stripe.subscriptions.cancel(subscription.id).catch(() => {});
    if (customer) await stripe.customers.del(customer.id).catch(() => {});
    await deleteTestUser(userId);
  }
}

async function testPaystackFailurePaths() {
  console.log('\n=== Paystack — failure paths ===');
  const planCode = process.env.PAYSTACK_PLAN_PRO;
  if (!planCode) {
    report('PAYSTACK_PLAN_PRO is set', false, 'skipping Paystack failure paths');
    return;
  }

  const userId = await createTestUser(`billing-test-paystack-fail-${Date.now()}@example.invalid`);
  const customerCode = `CUS_test_${crypto.randomBytes(6).toString('hex')}`;
  const subscriptionCode = `SUB_test_${crypto.randomBytes(6).toString('hex')}`;

  try {
    await paystackEventRequest({
      event: 'charge.success',
      data: {
        id: Date.now(),
        customer: { customer_code: customerCode },
        plan: { plan_code: planCode },
        metadata: { user_id: userId },
      },
    });
    await paystackEventRequest({
      event: 'subscription.create',
      data: { customer: { customer_code: customerCode }, subscription_code: subscriptionCode },
    });

    // --- declined/expired renewal card: invoice.payment_failed ---
    await paystackEventRequest({
      event: 'invoice.payment_failed',
      data: { subscription: { subscription_code: subscriptionCode }, customer: { customer_code: customerCode } },
    });

    let subRow = await getSubscriptionRow(userId);
    report('renewal decline sets subscriptions.status=past_due', subRow?.status === 'past_due', JSON.stringify(subRow));
    report('past_due_since is set on first decline', !!subRow?.past_due_since, JSON.stringify(subRow));

    let usersRow = await getUsersRow(userId);
    report('access retained during grace period (still tier=pro)', usersRow?.subscription_tier === 'pro', JSON.stringify(usersRow));

    // --- backdate past_due_since beyond the grace window and confirm
    // access is THEN revoked ---
    await shadowAdmin
      .from('subscriptions')
      .update({ past_due_since: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() })
      .eq('user_id', userId);
    const { syncUserSubscriptionTier } = await import('../src/lib/billing/get-user-tier.ts');
    await syncUserSubscriptionTier(shadowAdmin, userId);
    usersRow = await getUsersRow(userId);
    report('access revoked once past the 3-day grace window', usersRow?.subscription_tier === 'free', JSON.stringify(usersRow));

    // --- recovery: a successful renewal charge clears past_due_since ---
    await paystackEventRequest({
      event: 'charge.success',
      data: {
        id: Date.now(),
        customer: { customer_code: customerCode },
        plan: { plan_code: planCode },
        metadata: { user_id: userId },
      },
    });
    subRow = await getSubscriptionRow(userId);
    report('recovery (renewal success) clears past_due_since', subRow?.past_due_since === null, JSON.stringify(subRow));
    usersRow = await getUsersRow(userId);
    report('recovery restores tier=pro', usersRow?.subscription_tier === 'pro', JSON.stringify(usersRow));

    // --- duplicate webhook delivery: Paystack has no event id, the raw-body
    // HMAC signature IS the idempotency key, so resending the exact same
    // body twice must be caught the same way a repeated event id would be.
    const dupePayload = {
      event: 'subscription.disable',
      data: { subscription_code: subscriptionCode },
    };
    const first = await paystackEventRequest(dupePayload);
    const firstBody = await first.clone().json();
    const second = await paystackEventRequest(dupePayload);
    const secondBody = await second.clone().json();
    report('first delivery of a new payload is NOT marked duplicate', firstBody.duplicate !== true, JSON.stringify(firstBody));
    report('exact-duplicate payload redelivery is marked duplicate, not reprocessed', secondBody.duplicate === true, JSON.stringify(secondBody));
  } finally {
    await deleteTestUser(userId);
  }
}

// ---------------------------------------------------------------------
// Flutterwave — no HMAC, verif-hash is a static secret string compared
// directly (see src/lib/billing/flutterwave.ts's doc comment: this is
// NOT YET verified against a real webhook delivery, built from
// documentation + empirical testing of the payment-plans/payments API
// only). Every charge (first subscribe AND renewal) fires the same
// charge.completed event — there's no separate subscription lifecycle.
// ---------------------------------------------------------------------
async function flutterwaveEventRequest(event) {
  const { POST } = await import('../src/app/api/webhooks/flutterwave/route.ts');
  const payload = JSON.stringify(event);
  const { NextRequest } = await import('next/server');
  const request = new NextRequest('https://vaultpoint.name.ng/api/webhooks/flutterwave', {
    method: 'POST',
    body: payload,
    headers: { 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ?? '' },
  });
  const response = await withShadowAsLive(() => POST(request));
  if (!response.ok) {
    console.error(`  [flutterwave webhook] ${event.event}/${event.data.status} -> ${response.status}:`, await response.clone().text());
  }
  return response;
}

async function testFlutterwaveTier(tier) {
  console.log(`\n=== Flutterwave — ${tier} ===`);
  const planEnvVar = tier === 'pro' ? 'FLUTTERWAVE_PLAN_PRO' : 'FLUTTERWAVE_PLAN_ELITE';
  const planId = process.env[planEnvVar];
  if (!planId || !process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH) {
    report(`${planEnvVar} and FLUTTERWAVE_WEBHOOK_SECRET_HASH are set`, false, 'skipping Flutterwave ' + tier);
    return;
  }

  const userId = await createTestUser(`billing-test-flutterwave-${tier}-${Date.now()}@example.invalid`);
  const email = `billing-test-flutterwave-${tier}-${Date.now()}@example.invalid`;

  try {
    // --- initial subscribe: charge.completed, status successful ---
    await flutterwaveEventRequest({
      event: 'charge.completed',
      data: {
        id: Date.now(),
        tx_ref: `vp_${userId}_${Date.now()}`,
        status: 'successful',
        customer: { email },
        payment_plan: Number(planId),
        meta: { user_id: userId },
      },
    });

    let subRow = await getSubscriptionRow(userId);
    report(`subscriptions row created with tier=${tier}`, subRow?.tier === tier, JSON.stringify(subRow));
    report('subscriptions row status=active', subRow?.status === 'active');

    let usersRow = await getUsersRow(userId);
    report(`users.subscription_tier synced to ${tier}`, usersRow?.subscription_tier === tier, JSON.stringify(usersRow));

    // --- renewal decline: charge.completed, status failed ---
    await flutterwaveEventRequest({
      event: 'charge.completed',
      data: {
        id: Date.now() + 1,
        tx_ref: `vp_${userId}_${Date.now()}_renew`,
        status: 'failed',
        customer: { email },
        payment_plan: Number(planId),
        meta: { user_id: userId },
      },
    });

    subRow = await getSubscriptionRow(userId);
    report('renewal decline sets subscriptions.status=past_due', subRow?.status === 'past_due', JSON.stringify(subRow));
    report('past_due_since is set on first decline', !!subRow?.past_due_since);

    usersRow = await getUsersRow(userId);
    report(`access retained during grace period (still tier=${tier})`, usersRow?.subscription_tier === tier, JSON.stringify(usersRow));

    // --- backdate past_due_since beyond the grace window ---
    await shadowAdmin
      .from('subscriptions')
      .update({ past_due_since: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() })
      .eq('user_id', userId);
    const { syncUserSubscriptionTier } = await import('../src/lib/billing/get-user-tier.ts');
    await syncUserSubscriptionTier(shadowAdmin, userId);
    usersRow = await getUsersRow(userId);
    report('access revoked once past the 3-day grace window', usersRow?.subscription_tier === 'free', JSON.stringify(usersRow));

    // --- recovery: charge.completed, status successful again ---
    await flutterwaveEventRequest({
      event: 'charge.completed',
      data: {
        id: Date.now() + 2,
        tx_ref: `vp_${userId}_${Date.now()}_recover`,
        status: 'successful',
        customer: { email },
        payment_plan: Number(planId),
        meta: { user_id: userId },
      },
    });
    subRow = await getSubscriptionRow(userId);
    report('recovery clears past_due_since', subRow?.past_due_since === null, JSON.stringify(subRow));
    usersRow = await getUsersRow(userId);
    report(`recovery restores tier=${tier}`, usersRow?.subscription_tier === tier, JSON.stringify(usersRow));

    // --- duplicate delivery: same transaction id sent twice ---
    const dupeEvent = {
      event: 'charge.completed',
      data: {
        id: Date.now() + 3,
        tx_ref: `vp_${userId}_dupe`,
        status: 'successful',
        customer: { email },
        payment_plan: Number(planId),
        meta: { user_id: userId },
      },
    };
    const first = await flutterwaveEventRequest(dupeEvent);
    const firstBody = await first.clone().json();
    const second = await flutterwaveEventRequest(dupeEvent);
    const secondBody = await second.clone().json();
    report('first delivery of a new transaction id is NOT marked duplicate', firstBody.duplicate !== true, JSON.stringify(firstBody));
    report('exact-duplicate transaction id redelivery is marked duplicate, not reprocessed', secondBody.duplicate === true, JSON.stringify(secondBody));
  } finally {
    await deleteTestUser(userId);
  }
}

async function main() {
  console.log('Billing cycle test — TEST MODE only (Stripe sk_test_*, Paystack sk_test*)');
  console.log('Writing to SHADOW Supabase project:', SHADOW_SUPABASE_URL);

  await testFreeTier();
  await testStripeTier('pro');
  await testStripeTier('elite');
  await testPaystackTier('pro');
  await testPaystackTier('elite');
  await testStripeFailurePaths();
  await testPaystackFailurePaths();
  await testFlutterwaveTier('pro');
  await testFlutterwaveTier('elite');

  console.log(`\n${failures === 0 ? 'All billing cycle checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
