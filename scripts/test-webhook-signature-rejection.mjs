// Day 3 of the launch sprint ("Billing: go live") item 2 — confirms
// signature verification is actually ENFORCED on all three webhook
// route handlers: a bad or missing signature must be rejected (400,
// never {received:true}) before any processing happens. Complements
// scripts/test-billing-cycle.mjs, which only ever exercises the
// ACCEPT path (a validly-signed payload) — this is the reject path.
//
// Usage: npx tsx scripts/test-webhook-signature-rejection.mjs
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_local_sig_check';

const { NextRequest } = await import('next/server');

let failures = 0;

async function checkRejected(name, importPath, headers, body) {
  const { POST } = await import(importPath);
  const req = new NextRequest('https://vaultpoint.name.ng/webhook', { method: 'POST', body, headers });
  const res = await POST(req);
  const json = await res.clone().json().catch(() => ({}));
  const rejected = res.status === 400 && !json.received;
  if (rejected) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name} -> status=${res.status} body=${JSON.stringify(json)}`);
    failures += 1;
  }
}

console.log('=== Stripe ===');
await checkRejected(
  'bad signature rejected',
  '../src/app/api/webhooks/stripe/route.ts',
  { 'stripe-signature': 't=1,v1=deadbeef' },
  JSON.stringify({ id: 'evt_fake', type: 'checkout.session.completed', data: { object: {} } })
);
await checkRejected(
  'missing signature rejected',
  '../src/app/api/webhooks/stripe/route.ts',
  {},
  JSON.stringify({ id: 'evt_fake2', type: 'checkout.session.completed', data: { object: {} } })
);

console.log('\n=== Paystack ===');
await checkRejected(
  'bad signature rejected',
  '../src/app/api/webhooks/paystack/route.ts',
  { 'x-paystack-signature': 'deadbeef' },
  JSON.stringify({ event: 'charge.success', data: {} })
);
await checkRejected(
  'missing signature rejected',
  '../src/app/api/webhooks/paystack/route.ts',
  {},
  JSON.stringify({ event: 'charge.success', data: {} })
);

console.log('\n=== Flutterwave ===');
await checkRejected(
  'bad verif-hash rejected',
  '../src/app/api/webhooks/flutterwave/route.ts',
  { 'verif-hash': 'wrong-value' },
  JSON.stringify({ event: 'charge.completed', data: {} })
);
await checkRejected(
  'missing verif-hash rejected',
  '../src/app/api/webhooks/flutterwave/route.ts',
  {},
  JSON.stringify({ event: 'charge.completed', data: {} })
);

console.log(`\n${failures === 0 ? 'All signature-rejection checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
