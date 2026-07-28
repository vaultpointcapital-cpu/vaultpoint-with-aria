// Proves the Step-Up Auth Ticket 3 TOTP enrollment/verify flow end-to-end
// against the running dev server (real HTTP, real session cookies), and
// that an active enrollment makes 'totp' usable as a real step-up confirm
// method (Ticket 2). Runs against SHADOW — same reasoning as
// scripts/test-step-up-flow.mjs's header comment: this migration
// (totp_enrollments) has only been applied to shadow, and the dev server
// this hits must itself be started with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY
// and SUPABASE_SERVICE_ROLE_KEY overridden to the SHADOW_* values below.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { base32Decode, generateTotpCode } from '../src/lib/auth/totp.ts';

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

async function main() {
  const password = 'TotpFlowTest!2026x';
  const { data: user } = await admin.auth.admin.createUser({
    email: `totp-flow-test-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const anon = createClient(supabaseUrl, anonKey);
  const { data: session } = await anon.auth.signInWithPassword({ email: user.user.email, password });

  try {
    const unauthEnroll = await call('POST', '/api/auth/totp/enroll', null);
    report('unauthenticated enroll is rejected', unauthEnroll.status === 401);
    const unauthVerify = await call('POST', '/api/auth/totp/verify', null, { code: '000000' });
    report('unauthenticated verify is rejected', unauthVerify.status === 401);

    const enroll = await call('POST', '/api/auth/totp/enroll', session.session);
    report('enroll succeeds (201)', enroll.status === 201, JSON.stringify(enroll.body));
    report('enroll returns an otpauth_url and a base32 secret', !!enroll.body?.otpauth_url && !!enroll.body?.secret, JSON.stringify(enroll.body));

    const secret = base32Decode(enroll.body.secret);
    const codeNow = generateTotpCode(secret, Date.now());

    const wrongCode = codeNow === '000000' ? '111111' : '000000';
    const verifyWrong = await call('POST', '/api/auth/totp/verify', session.session, { code: wrongCode });
    report('verifying with a wrong code is rejected', verifyWrong.status === 422, JSON.stringify(verifyWrong.body));

    const { data: rowPending } = await admin.from('totp_enrollments').select('status').eq('user_id', user.user.id).single();
    report('enrollment is still pending after a wrong code', rowPending?.status === 'pending', JSON.stringify(rowPending));

    const verifyGood = await call('POST', '/api/auth/totp/verify', session.session, { code: codeNow });
    report('verifying with the correct code activates the enrollment', verifyGood.status === 200 && verifyGood.body?.status === 'activated', JSON.stringify(verifyGood.body));

    const { data: rowActive } = await admin.from('totp_enrollments').select('status, last_consumed_counter').eq('user_id', user.user.id).single();
    report('enrollment row is now active with a consumed counter recorded', rowActive?.status === 'active' && rowActive?.last_consumed_counter !== null, JSON.stringify(rowActive));

    const verifyReplay = await call('POST', '/api/auth/totp/verify', session.session, { code: codeNow });
    report('replaying the same activation code is rejected', verifyReplay.status === 422, JSON.stringify(verifyReplay.body));

    // --- Step-Up wiring: 'totp' now appears as an offered method, and a fresh code confirms for real ---
    const init = await call('POST', '/api/auth/step-up/initiate', session.session, { action_type: 'test-totp' });
    report('step-up initiate now offers totp as a method', init.body?.methods?.includes('totp'), JSON.stringify(init.body));

    // A code for one step in the future is still inside confirm's ±1
    // window when submitted immediately, and (being a step later than
    // the one activation already consumed) isn't a replay.
    const nextStepCode = generateTotpCode(secret, Date.now() + 30_000);
    const confirmGood = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init.body.approval_id,
      method: 'totp',
      totp_code: nextStepCode,
    });
    report('step-up confirm approves with a fresh, real TOTP code', confirmGood.status === 200 && confirmGood.body?.status === 'approved', JSON.stringify(confirmGood.body));

    const confirmReplay = await call('POST', '/api/auth/step-up/confirm', session.session, {
      approval_id: init.body.approval_id,
      method: 'totp',
      totp_code: '000000',
    });
    report('idempotent re-confirm ignores a bad second code and returns the first outcome', confirmReplay.status === 200 && confirmReplay.body?.status === 'approved', JSON.stringify(confirmReplay.body));
  } finally {
    await admin.from('step_up_audit_log').delete().eq('user_id', user.user.id);
    await admin.from('step_up_approvals').delete().eq('user_id', user.user.id);
    await admin.from('totp_enrollments').delete().eq('user_id', user.user.id);
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll TOTP enrollment/step-up checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
