// Proves POST /api/auth/devices/register end-to-end against the running
// dev server (real HTTP, real session cookie): unauthenticated rejected,
// registration succeeds, re-registering the same token is idempotent
// (same device_id), and a bad platform value is rejected.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3004';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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

async function call(session, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['Cookie'] = cookieHeaderFor(session);
  const res = await fetch(`${BASE_URL}/api/auth/devices/register`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  const password = 'DeviceFlowTest!2026x';
  const { data: user } = await admin.auth.admin.createUser({ email: `device-flow-test-${Date.now()}@example.com`, password, email_confirm: true });
  const anon = createClient(supabaseUrl, anonKey);
  const { data: session } = await anon.auth.signInWithPassword({ email: user.user.email, password });

  const token = `fcm-test-token-${Date.now()}`;
  try {
    const unauth = await call(null, { device_token: token, platform: 'android' });
    report('unauthenticated request is rejected', unauth.status === 401);

    const badPlatform = await call(session.session, { device_token: token, platform: 'windows-phone' });
    report('invalid platform is rejected', badPlatform.status === 422, JSON.stringify(badPlatform.body));

    const first = await call(session.session, { device_token: token, platform: 'android' });
    report('registration succeeds (201)', first.status === 201, JSON.stringify(first.body));

    const second = await call(session.session, { device_token: token, platform: 'android' });
    report('re-registering the same token returns the same device_id', second.status === 201 && second.body?.device_id === first.body?.device_id, JSON.stringify({ first: first.body, second: second.body }));
  } finally {
    await admin.from('user_devices').delete().eq('user_id', user.user.id);
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nAll device registration flow checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
