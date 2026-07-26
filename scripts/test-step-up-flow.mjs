// Proves the Step-Up Auth Ticket 2 initiate/confirm/status flow end-to-end
// against the running dev server (real HTTP, real session cookies), and
// its wiring into the two highest-risk flows the spec names explicitly:
// POST /api/managed-accounts/:id/withdraw and POST /api/brokers.
//
// Runs against SHADOW, not live: this migration (step_up_approvals /
// step_up_audit_log) has only been applied to the shadow project so
// far, and supabase/README.md is explicit that live schema/data changes
// are the project owner's call, not something this script should do on
// its own. The dev server this hits (TEST_BASE_URL, default localhost:3004)
// must itself be started with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY overridden to the SHADOW_* values below —
// otherwise every request 401s (a session minted against shadow doesn't
// verify against live's different JWT secret), the same mismatch
// test-rls-isolation.mjs's header comment warns about.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3004';
const supabaseUrl = process.env.SHADOW_SUPABASE_URL;
const admin = createClient(supabaseUrl, process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY);
const anonKey = process.env.SHADOW_SUPABASE_ANON_KEY;

let failures = 0;
function report(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
}

function cookieHeaderFor(session) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  return `sb-${projectRef}-auth-token=${cookieValue}`;
}

async function call(method, path, session, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['Cookie'] = cookieHeaderFor(session);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function hmacFor(rawToken, approvalId) {
  return crypto.createHmac('sha256', rawToken).update(approvalId, 'utf8').digest('hex');
}

function approvalRowIdFrom(jwt) {
  const [, payloadB64] = jwt.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')).sub;
}

async function main() {
  const password = 'StepUpFlowTest!2026x';
  const { data: user } = await admin.auth.admin.createUser({
    email: `step-up-flow-test-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const anon = createClient(supabaseUrl, anonKey);
  const { data: session } = await anon.auth.signInWithPassword({ email: user.user.email, password });
  const rawToken = `fcm-step-up-test-${Date.now()}`;

  let managedAccountId = null;
  let authorizationId = null;
  let brokerConnectionId = null;

  try {
    const unauthInit = await call('POST', '/api/auth/step-up/initiate', null, {
      action_type: 'withdrawal',
      resource_id: 'acct-1',
    });
    report('unauthenticated initiate is rejected', unauthInit.status === 401);

    const init1 = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'withdrawal',
      resource_id: 'acct-1',
    });
    report('initiate succeeds (201)', init1.status === 201, JSON.stringify(init1.body));
    report(
      'no device registered yet -> methods is empty',
      Array.isArray(init1.body?.methods) && init1.body.methods.length === 0,
      JSON.stringify(init1.body)
    );

    const confirmUnoffered = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init1.body.approval_id,
      method: 'push',
      signed_response: 'a'.repeat(64),
    });
    report(
      'confirm rejects a method that was never offered for this approval',
      confirmUnoffered.status === 422,
      JSON.stringify(confirmUnoffered.body)
    );

    const deviceReg = await call('POST', '/api/auth/devices/register', session.session, {
      device_token: rawToken,
      platform: 'android',
    });
    report('device registration succeeds', deviceReg.status === 201, JSON.stringify(deviceReg.body));

    const init2 = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'withdrawal',
      resource_id: 'acct-1',
    });
    report(
      'methods includes push once a device is registered',
      init2.body?.methods?.includes('push'),
      JSON.stringify(init2.body)
    );

    const goodSig = hmacFor(rawToken, init2.body.approval_id);
    const confirmGood = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init2.body.approval_id,
      method: 'push',
      signed_response: goodSig,
    });
    report(
      'confirm with the correct device signature approves',
      confirmGood.status === 200 && confirmGood.body?.status === 'approved',
      JSON.stringify(confirmGood.body)
    );

    const confirmReplay = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init2.body.approval_id,
      method: 'push',
      signed_response: 'f'.repeat(64),
    });
    report(
      'idempotent redelivery ignores a bad second proof and returns the first outcome',
      confirmReplay.status === 200 && confirmReplay.body?.status === 'approved',
      JSON.stringify(confirmReplay.body)
    );

    const statusRes = await call(
      'GET',
      `/api/auth/step-up/status/${encodeURIComponent(init2.body.approval_id)}`,
      session.session
    );
    report(
      'status endpoint reports approved',
      statusRes.status === 200 && statusRes.body?.status === 'approved',
      JSON.stringify(statusRes.body)
    );
    report('status includes a resolved_at timestamp', statusRes.body?.resolved_at !== null);

    const init3 = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'withdrawal',
      resource_id: 'acct-1',
    });
    const confirmBad = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init3.body.approval_id,
      method: 'push',
      signed_response: '0'.repeat(64),
    });
    report(
      'confirm with a wrong device signature denies',
      confirmBad.status === 200 && confirmBad.body?.status === 'denied',
      JSON.stringify(confirmBad.body)
    );

    const goodSig3 = hmacFor(rawToken, init3.body.approval_id);
    const confirmDeniedReplay = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init3.body.approval_id,
      method: 'push',
      signed_response: goodSig3,
    });
    report(
      'a denied approval stays denied even when re-confirmed with the correct signature',
      confirmDeniedReplay.status === 200 && confirmDeniedReplay.body?.status === 'denied',
      JSON.stringify(confirmDeniedReplay.body)
    );

    const init4 = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'withdrawal',
      resource_id: 'acct-1',
    });
    await admin
      .from('step_up_approvals')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', approvalRowIdFrom(init4.body.approval_id));

    const statusExpired = await call(
      'GET',
      `/api/auth/step-up/status/${encodeURIComponent(init4.body.approval_id)}`,
      session.session
    );
    report(
      'status reports expired once past its TTL, read-only (lazy expiry)',
      statusExpired.body?.status === 'expired',
      JSON.stringify(statusExpired.body)
    );

    const goodSig4 = hmacFor(rawToken, init4.body.approval_id);
    const confirmExpired = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init4.body.approval_id,
      method: 'push',
      signed_response: goodSig4,
    });
    report(
      'confirming an expired approval reports expired even with a correct signature',
      confirmExpired.body?.status === 'expired',
      JSON.stringify(confirmExpired.body)
    );

    // --- Wiring: POST /api/brokers (broker-credential-change) ---
    const brokerMissingApproval = await call('POST', '/api/brokers', session.session, {
      broker: 'bybit',
      label: 'Test',
      apiKey: '1234567890',
      apiSecret: '1234567890',
    });
    report(
      'adding a broker connection without stepUpApprovalId is rejected',
      brokerMissingApproval.status === 422,
      JSON.stringify(brokerMissingApproval.body)
    );

    const brokerWrongApproval = await call('POST', '/api/brokers', session.session, {
      broker: 'bybit',
      label: 'Test',
      apiKey: '1234567890',
      apiSecret: '1234567890',
      stepUpApprovalId: init2.body.approval_id, // approved, but for action_type 'withdrawal' + a different resource_id
    });
    report(
      'a step-up approval for the wrong action_type is rejected',
      brokerWrongApproval.status === 422,
      JSON.stringify(brokerWrongApproval.body)
    );

    const initBroker = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'broker_credential_change',
    });
    const goodSigBroker = hmacFor(rawToken, initBroker.body.approval_id);
    await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: initBroker.body.approval_id,
      method: 'push',
      signed_response: goodSigBroker,
    });
    const brokerOk = await call('POST', '/api/brokers', session.session, {
      broker: 'bybit',
      label: 'Test',
      apiKey: '1234567890',
      apiSecret: '1234567890',
      stepUpApprovalId: initBroker.body.approval_id,
    });
    report(
      'adding a broker connection with a matching approved step-up succeeds',
      brokerOk.status === 201,
      JSON.stringify(brokerOk.body)
    );
    brokerConnectionId = brokerOk.body?.connection?.id ?? null;

    // --- Wiring: POST /api/managed-accounts/:id/withdraw ---
    const { data: authorization } = await admin
      .from('client_authorizations')
      .insert({
        user_id: user.user.id,
        document_version: 'v1',
        document_url: 'https://example.com/doc',
        typed_legal_name: 'Test User',
      })
      .select('id')
      .single();
    authorizationId = authorization.id;

    const { data: account } = await admin
      .from('managed_accounts')
      .insert({
        user_id: user.user.id,
        tier: 'bronze',
        profit_split_pct: 20,
        max_drawdown_pct: 20,
        withdrawal_window_cadence: 'on_demand',
        client_authorization_id: authorizationId,
        kyc_status: 'verified',
        broker: 'metatrader',
        mt_login: '12345',
        mt_server: 'test-server',
        encrypted_mt_password: 'x',
        mt_password_iv: 'x',
        status: 'active',
        starting_capital: 1000,
      })
      .select('id')
      .single();
    managedAccountId = account.id;

    const withdrawMissingApproval = await call('POST', `/api/managed-accounts/${managedAccountId}/withdraw`, session.session, {
      withdrawalType: 'full_closure',
      payoutMethod: 'bank_transfer',
      confirmUnderstanding: true,
    });
    report(
      'withdrawal without stepUpApprovalId is rejected',
      withdrawMissingApproval.status === 422,
      JSON.stringify(withdrawMissingApproval.body)
    );

    const initWithdraw = await call('POST', '/api/auth/step-up/initiate', session.session, {
      action_type: 'withdrawal',
      resource_id: managedAccountId,
    });
    const goodSigWithdraw = hmacFor(rawToken, initWithdraw.body.approval_id);
    await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: initWithdraw.body.approval_id,
      method: 'push',
      signed_response: goodSigWithdraw,
    });

    const withdrawOk = await call('POST', `/api/managed-accounts/${managedAccountId}/withdraw`, session.session, {
      withdrawalType: 'full_closure',
      payoutMethod: 'bank_transfer',
      confirmUnderstanding: true,
      stepUpApprovalId: initWithdraw.body.approval_id,
    });
    report(
      'withdrawal with a matching approved step-up succeeds',
      withdrawOk.status === 201,
      JSON.stringify(withdrawOk.body)
    );
  } finally {
    if (brokerConnectionId) await admin.from('broker_connections').delete().eq('id', brokerConnectionId);
    if (managedAccountId) {
      // The withdraw route's createNotification() call inserts a row here —
      // FK-blocks the managed_accounts delete below if left behind.
      await admin.from('managed_account_notifications').delete().eq('managed_account_id', managedAccountId);
      await admin.from('profit_distributions').delete().eq('managed_account_id', managedAccountId);
      await admin.from('managed_accounts').delete().eq('id', managedAccountId);
    }
    if (authorizationId) await admin.from('client_authorizations').delete().eq('id', authorizationId);
    await admin.from('step_up_audit_log').delete().eq('user_id', user.user.id);
    await admin.from('step_up_approvals').delete().eq('user_id', user.user.id);
    await admin.from('user_devices').delete().eq('user_id', user.user.id);
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll step-up flow checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
