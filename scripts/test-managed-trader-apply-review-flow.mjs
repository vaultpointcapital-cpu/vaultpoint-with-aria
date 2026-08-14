// Proves the Managed Trader Pathway Sprint 1+2 backend end-to-end
// against the running dev server (real HTTP, real session cookies) —
// apply (with the full Sprint 2 questionnaire fields) -> pending
// (invisible to the public directory, KYC row auto-created) -> approval
// blocked until KYC is verified -> admin review -> approved (now
// visible) -> non-admin cannot review -> duplicate apply rejected ->
// reviewing an already-decided application rejected -> max_clients
// survives a review that omits it.
//
// Uses disposable throwaway users against whatever DB the dev server at
// BASE_URL is actually pointed at (this repo's .env.local -> live), same
// technique as this session's earlier checkout/Aria browser verification
// — cleaned up in the finally block either way.
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
  const password = 'MtpFlowTest!2026x';
  const { data: traderUser } = await admin.auth.admin.createUser({
    email: `mtp-flow-trader-${Date.now()}@example.com`, password, email_confirm: true,
  });
  const { data: adminUser } = await admin.auth.admin.createUser({
    email: `mtp-flow-admin-${Date.now()}@example.com`, password, email_confirm: true,
  });
  const { data: nonAdminUser } = await admin.auth.admin.createUser({
    email: `mtp-flow-nonadmin-${Date.now()}@example.com`, password, email_confirm: true,
  });
  await admin.from('users').update({ is_admin: true }).eq('id', adminUser.user.id);

  const anon1 = createClient(supabaseUrl, anonKey);
  const { data: traderSession } = await anon1.auth.signInWithPassword({ email: traderUser.user.email, password });
  const anon2 = createClient(supabaseUrl, anonKey);
  const { data: adminSession } = await anon2.auth.signInWithPassword({ email: adminUser.user.email, password });
  const anon3 = createClient(supabaseUrl, anonKey);
  const { data: nonAdminSession } = await anon3.auth.signInWithPassword({ email: nonAdminUser.user.email, password });

  const fullApplication = {
    proposed_profit_split: 70,
    max_clients: 5,
    strategy_description: 'SMC-based swing trading focused on institutional order flow.',
    has_managed_funds_before: false,
    academy_modules_confirmed: true,
    understands_trade_only: true,
    agrees_to_audit_logging: true,
  };

  let traderId;
  try {
    const missingFields = await call('POST', '/api/managed-traders/apply', traderSession.session, { proposed_profit_split: 70 });
    report('apply without the required Sprint 2 fields is rejected', missingFields.status === 422, JSON.stringify(missingFields.body));

    const applied = await call('POST', '/api/managed-traders/apply', traderSession.session, fullApplication);
    report('apply succeeds (201)', applied.status === 201, JSON.stringify(applied.body));
    traderId = applied.body?.trader?.id;
    report('new application is status=pending', applied.body?.trader?.status === 'pending');

    const { data: kycRow } = await admin.from('kyc_verifications').select('id, state').eq('managed_trader_id', traderId).maybeSingle();
    report('applying auto-created a KYC verification row', kycRow?.state === 'not_started', JSON.stringify(kycRow));

    const dup = await call('POST', '/api/managed-traders/apply', traderSession.session, fullApplication);
    report('duplicate apply while pending is rejected', dup.status === 422);

    const pendingGet = await call('GET', `/api/managed-traders/${traderId}`, null);
    report('pending trader is NOT visible via the public GET', pendingGet.status === 404);

    const nonAdminReview = await call('POST', `/api/admin/managed-traders/${traderId}/review`, nonAdminSession.session, { status: 'approved', approved_profit_split: 65 });
    report('non-admin cannot review an application', nonAdminReview.status === 403);

    const missingSplit = await call('POST', `/api/admin/managed-traders/${traderId}/review`, adminSession.session, { status: 'approved' });
    report('approving without approved_profit_split is rejected', missingSplit.status === 422);

    const approveBeforeKyc = await call('POST', `/api/admin/managed-traders/${traderId}/review`, adminSession.session, { status: 'approved', approved_profit_split: 65 });
    report('approving before KYC is verified is rejected', approveBeforeKyc.status === 422 && /KYC/.test(approveBeforeKyc.body?.error ?? ''), JSON.stringify(approveBeforeKyc.body));

    await admin.from('kyc_verifications').update({ state: 'verified', decided_at: new Date().toISOString() }).eq('id', kycRow.id);

    const review = await call('POST', `/api/admin/managed-traders/${traderId}/review`, adminSession.session, { status: 'approved', approved_profit_split: 65, reviewer_notes: 'Looks solid.' });
    report('admin review succeeds once KYC is verified', review.status === 200, JSON.stringify(review.body));
    report('status is now approved', review.body?.trader?.status === 'approved');
    report('max_clients (5) survived a review that omitted it', review.body?.trader?.max_clients === 5, JSON.stringify(review.body));

    const reReview = await call('POST', `/api/admin/managed-traders/${traderId}/review`, adminSession.session, { status: 'rejected' });
    report('re-reviewing an already-decided application is rejected', reReview.status === 422);

    const approvedGet = await call('GET', `/api/managed-traders/${traderId}`, null);
    report('approved trader IS visible via the public GET', approvedGet.status === 200, JSON.stringify(approvedGet.body));
    report('profile shows the approved split (65), not the proposed one (70)', approvedGet.body?.trader?.profitSplitPct === 65, JSON.stringify(approvedGet.body));
  } finally {
    await admin.from('kyc_verifications').delete().eq('managed_trader_id', traderId ?? '');
    await admin.from('managed_traders').delete().eq('id', traderId ?? '');
    await admin.auth.admin.deleteUser(traderUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(adminUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(nonAdminUser.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll Managed Trader Pathway apply/review flow checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
