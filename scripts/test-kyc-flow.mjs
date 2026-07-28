// Proves the KYC World-B module end-to-end against shadow:
// 1. Provisioning a managed account creates a kyc_verifications row.
// 2. The advance-to-funding gate rejects an unverified account.
// 3. A VerifyMe webhook decision flips kyc_verifications AND
//    managed_accounts.kyc_status (the actual bug fix — nothing could do
//    this before).
// 4. The gate now allows advancing.
// 5. A late/duplicate webhook redelivery doesn't regress the decision.
//
// Calls the real route handlers against shadow, same technique as
// scripts/test-webhook-retry-after-failure.mjs.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const SHADOW_SUPABASE_URL = process.env.SHADOW_SUPABASE_URL;
const SHADOW_SERVICE_ROLE_KEY = process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY;
const shadowAdmin = createClient(SHADOW_SUPABASE_URL, SHADOW_SERVICE_ROLE_KEY);

const TEST_VERIFYME_SECRET = 'verifyme_test_secret_' + crypto.randomBytes(8).toString('hex');
process.env.VERIFYME_WEBHOOK_SECRET = TEST_VERIFYME_SECRET;

let failures = 0;
function report(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
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

async function main() {
  const { data: authUser, error: authUserErr } = await shadowAdmin.auth.admin.createUser({
    email: `kyc-flow-test-${Date.now()}@example.com`,
    password: 'KycFlowTest!2026x',
    email_confirm: true,
  });
  if (authUserErr) throw new Error(`seed auth user failed: ${authUserErr.message}`);
  const userId = authUser.user.id;

  const { error: userUpdateErr } = await shadowAdmin
    .from('users')
    .update({ country_code: 'NG', subscription_tier: 'elite' })
    .eq('id', userId);
  if (userUpdateErr) throw new Error(`seed user profile update failed: ${userUpdateErr.message}`);

  const { data: authorization, error: authErr } = await shadowAdmin.from('client_authorizations').insert({
    user_id: userId,
    document_version: 'v1',
    document_url: 'https://example.com/doc',
    typed_legal_name: 'Test User',
  }).select('id').single();
  if (authErr) throw new Error(`seed authorization failed: ${authErr.message}`);

  const { data: account, error: acctErr } = await shadowAdmin.from('managed_accounts').insert({
    user_id: userId,
    tier: 'bronze',
    profit_split_pct: 20,
    max_drawdown_pct: 20,
    withdrawal_window_cadence: 'monthly',
    client_authorization_id: authorization.id,
    kyc_status: 'pending',
    broker: 'metatrader',
    mt_login: '12345',
    mt_server: 'test-server',
    encrypted_mt_password: 'x',
    mt_password_iv: 'x',
    status: 'pending_kyc',
  }).select('id').single();
  if (acctErr) throw new Error(`seed managed_account failed: ${acctErr.message}`);
  const managedAccountId = account.id;

  try {
    // Step 1: getOrCreateKycVerificationRow (exercised directly, same fn the provisioning route calls)
    const { getOrCreateKycVerificationRow, isKycVerifiedForAccount } = await withShadowAsLive(
      () => import('../src/lib/kyc/verification-state.ts')
    );
    const row = await withShadowAsLive(() =>
      getOrCreateKycVerificationRow({ userId, managedAccountId, vendor: 'verifyme' })
    );
    report('kyc_verifications row created in not_started state', row.state === 'not_started', JSON.stringify(row));

    // Simulate the vendor call setting vendor_ref + submitted (would normally happen in the not-yet-built initiate step)
    await shadowAdmin.from('kyc_verifications').update({ vendor_ref: 'vref_123', state: 'pending', submitted_at: new Date().toISOString() }).eq('id', row.id);

    // Step 2: gate should reject before verification
    const verifiedBefore = await withShadowAsLive(() => isKycVerifiedForAccount(managedAccountId));
    report('gate reports NOT verified before webhook arrives', verifiedBefore === false);

    // Step 3: real VerifyMe webhook route, real HMAC signature
    const { POST } = await import('../src/app/api/webhooks/kyc/verifyme/route.ts');
    const { NextRequest } = await import('next/server');
    const payload = JSON.stringify({ status: 'success', reference: 'vref_123' });
    // verifyVerifyMeSignature does a direct shared-secret compare, not HMAC-of-body (see verifyme.ts) — send the secret itself.
    const request = new NextRequest('https://vaultpoint.name.ng/api/webhooks/kyc/verifyme', {
      method: 'POST',
      body: payload,
      headers: { 'x-verifyme-signature': TEST_VERIFYME_SECRET },
    });
    const response = await withShadowAsLive(() => POST(request));
    const body = await response.json();
    report('webhook accepted (200)', response.status === 200, JSON.stringify(body));

    const { data: rowAfter } = await shadowAdmin.from('kyc_verifications').select('state, decided_at').eq('id', row.id).single();
    report('kyc_verifications row flipped to verified', rowAfter.state === 'verified', JSON.stringify(rowAfter));

    const { data: accountAfter } = await shadowAdmin.from('managed_accounts').select('kyc_status, kyc_verified_at').eq('id', managedAccountId).single();
    report('managed_accounts.kyc_status synced to verified — THE bug fix', accountAfter.kyc_status === 'verified', JSON.stringify(accountAfter));
    report('managed_accounts.kyc_verified_at was stamped', accountAfter.kyc_verified_at !== null);

    // Step 4: gate now allows advancing
    const verifiedAfter = await withShadowAsLive(() => isKycVerifiedForAccount(managedAccountId));
    report('gate reports verified after webhook', verifiedAfter === true);

    // Step 5: a late duplicate/conflicting redelivery must not regress the decision
    const rejectedPayload = JSON.stringify({ status: 'failed', reference: 'vref_123' });
    const request2 = new NextRequest('https://vaultpoint.name.ng/api/webhooks/kyc/verifyme', {
      method: 'POST',
      body: rejectedPayload,
      headers: { 'x-verifyme-signature': TEST_VERIFYME_SECRET },
    });
    await withShadowAsLive(() => POST(request2));
    const { data: rowFinal } = await shadowAdmin.from('kyc_verifications').select('state').eq('id', row.id).single();
    report('a later conflicting webhook does NOT flip verified back', rowFinal.state === 'verified', JSON.stringify(rowFinal));

    // Real Stripe-webhook-style idempotency check: redeliver the SAME success event
    const request3 = new NextRequest('https://vaultpoint.name.ng/api/webhooks/kyc/verifyme', {
      method: 'POST',
      body: payload,
      headers: { 'x-verifyme-signature': TEST_VERIFYME_SECRET },
    });
    const response3 = await withShadowAsLive(() => POST(request3));
    const body3 = await response3.json();
    report('exact redelivery of the same event is reported as duplicate', body3.duplicate === true, JSON.stringify(body3));

    // Unsigned/bad-signature request must be rejected outright
    const badRequest = new NextRequest('https://vaultpoint.name.ng/api/webhooks/kyc/verifyme', {
      method: 'POST',
      body: payload,
      headers: { 'x-verifyme-signature': 'wrong-secret' },
    });
    const badResponse = await withShadowAsLive(() => POST(badRequest));
    report('request with wrong signature is rejected (400)', badResponse.status === 400);
  } finally {
    await shadowAdmin.from('kyc_verifications').delete().eq('managed_account_id', managedAccountId);
    await shadowAdmin.from('kyc_webhook_events').delete().eq('vendor', 'verifyme').eq('event_id', 'vref_123');
    await shadowAdmin.from('managed_accounts').delete().eq('id', managedAccountId);
    await shadowAdmin.from('client_authorizations').delete().eq('id', authorization.id);
    await shadowAdmin.auth.admin.deleteUser(userId).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll KYC flow checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
