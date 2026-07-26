// Proves the Step-Up Auth Ticket 6 new-device login alert end-to-end
// against the running dev server (real HTTP, real session cookies).
// Runs against SHADOW — same reasoning as
// scripts/test-step-up-flow.mjs's header comment: this migration
// (login_device_fingerprints) has only been applied to shadow, and the
// dev server this hits must itself be started with
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
// overridden to the SHADOW_* values below.
import { createClient } from '@supabase/supabase-js';
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

function sessionCookieFor(session) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  return `sb-${projectRef}-auth-token=${cookieValue}`;
}

async function callLoginDevice(session, deviceCookieValue) {
  const cookies = [sessionCookieFor(session)];
  if (deviceCookieValue) cookies.push(`vp_ldf=${deviceCookieValue}`);
  const res = await fetch(`${BASE_URL}/api/auth/login-device`, {
    method: 'POST',
    headers: { Cookie: cookies.join('; ') },
  });
  const json = await res.json().catch(() => null);
  const setCookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)).find((c) =>
    c.startsWith('vp_ldf=')
  );
  const newDeviceCookieValue = setCookie ? setCookie.split(';')[0].split('=')[1] : null;
  return { status: res.status, body: json, newDeviceCookieValue };
}

async function main() {
  const password = 'NewDeviceAlertTest!2026x';
  const { data: user } = await admin.auth.admin.createUser({
    email: `new-device-alert-test-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const anon = createClient(supabaseUrl, anonKey);
  const { data: session } = await anon.auth.signInWithPassword({ email: user.user.email, password });

  try {
    const unauthRes = await fetch(`${BASE_URL}/api/auth/login-device`, { method: 'POST' });
    report('unauthenticated call is rejected', unauthRes.status === 401);

    const first = await callLoginDevice(session.session, null);
    report('first-ever login from this browser is flagged as a new device', first.body?.new_device === true, JSON.stringify(first.body));
    report('a fingerprint cookie is set on the response', !!first.newDeviceCookieValue, JSON.stringify(first));

    const { data: rowsAfterFirst } = await admin
      .from('login_device_fingerprints')
      .select('id, user_agent, first_seen_ip')
      .eq('user_id', user.user.id);
    report('exactly one fingerprint row recorded so far', rowsAfterFirst?.length === 1, JSON.stringify(rowsAfterFirst));

    const second = await callLoginDevice(session.session, first.newDeviceCookieValue);
    report('re-login with the same browser cookie is NOT flagged as a new device', second.body?.new_device === false, JSON.stringify(second.body));

    const { data: rowsAfterSecond } = await admin
      .from('login_device_fingerprints')
      .select('id')
      .eq('user_id', user.user.id);
    report('still exactly one fingerprint row (no duplicate) after a recognized re-login', rowsAfterSecond?.length === 1, JSON.stringify(rowsAfterSecond));

    const third = await callLoginDevice(session.session, 'a-completely-different-browser-value');
    report('a different/unrecognized fingerprint is flagged as a new device again', third.body?.new_device === true, JSON.stringify(third.body));

    const { data: rowsAfterThird } = await admin
      .from('login_device_fingerprints')
      .select('id')
      .eq('user_id', user.user.id);
    report('a second distinct fingerprint row now exists', rowsAfterThird?.length === 2, JSON.stringify(rowsAfterThird));
  } finally {
    await admin.from('login_device_fingerprints').delete().eq('user_id', user.user.id);
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll new-device login alert checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
