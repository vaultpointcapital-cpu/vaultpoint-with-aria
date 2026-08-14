// Proves the Step-Up Auth Ticket 5 admin audit-log endpoint end-to-end
// against the running dev server (real HTTP, real session cookies).
// Runs against SHADOW — same reasoning as scripts/test-step-up-flow.mjs's
// header comment: the dev server this hits must itself be started with
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

function cookieHeaderFor(session) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  return `sb-${projectRef}-auth-token=${cookieValue}`;
}

async function call(session, query) {
  const headers = {};
  if (session) headers['Cookie'] = cookieHeaderFor(session);
  const res = await fetch(`${BASE_URL}/api/admin/step-up/audit-log${query ?? ''}`, { headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function seedApprovalAndAuditRow(admin, { userId, actionType, resourceId, status, createdAt }) {
  const { data: approval } = await admin
    .from('step_up_approvals')
    .insert({
      user_id: userId,
      action_type: actionType,
      resource_id: resourceId,
      methods: [],
      status,
      expires_at: new Date(Date.now() + 90_000).toISOString(),
      resolved_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  const { data: auditRow } = await admin
    .from('step_up_audit_log')
    .insert({
      approval_id: approval.id,
      user_id: userId,
      action_type: actionType,
      resource_id: resourceId,
      status,
      method: null,
      created_at: createdAt,
    })
    .select('id')
    .single();

  return { approvalId: approval.id, auditId: auditRow.id };
}

async function main() {
  const password = 'AuditLogAdminTest!2026x';
  const { data: testUser } = await admin.auth.admin.createUser({
    email: `audit-log-test-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const { data: otherUser } = await admin.auth.admin.createUser({
    email: `audit-log-other-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const { data: adminUser } = await admin.auth.admin.createUser({
    email: `audit-log-admin-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  await admin.from('users').update({ is_admin: true }).eq('id', adminUser.user.id);

  const anon = createClient(supabaseUrl, anonKey);
  const { data: testSession } = await anon.auth.signInWithPassword({ email: testUser.user.email, password });
  const { data: adminSession } = await anon.auth.signInWithPassword({ email: adminUser.user.email, password });

  const seeded = [];
  try {
    const unauth = await call(null);
    report('unauthenticated request is rejected', unauth.status === 401);

    const nonAdmin = await call(testSession.session);
    report('a non-admin request is rejected', nonAdmin.status === 403);

    const now = new Date();
    seeded.push(
      await seedApprovalAndAuditRow(admin, {
        userId: testUser.user.id, actionType: 'withdrawal', resourceId: 'acct-a', status: 'approved',
        createdAt: now.toISOString(),
      })
    );
    seeded.push(
      await seedApprovalAndAuditRow(admin, {
        userId: testUser.user.id, actionType: 'broker_credential_change', resourceId: null, status: 'denied',
        createdAt: now.toISOString(),
      })
    );
    seeded.push(
      await seedApprovalAndAuditRow(admin, {
        userId: otherUser.user.id, actionType: 'withdrawal', resourceId: 'acct-b', status: 'approved',
        createdAt: now.toISOString(),
      })
    );

    const byUser = await call(adminSession.session, `?user_id=${testUser.user.id}`);
    report('admin filtering by user_id returns exactly that user\'s 2 entries', byUser.status === 200 && byUser.body?.entries?.length === 2, JSON.stringify(byUser.body));

    const byUserAndAction = await call(adminSession.session, `?user_id=${testUser.user.id}&action_type=withdrawal`);
    report('admin filtering by user_id + action_type narrows to 1 entry', byUserAndAction.body?.entries?.length === 1 && byUserAndAction.body.entries[0].action_type === 'withdrawal', JSON.stringify(byUserAndAction.body));

    const byOtherUser = await call(adminSession.session, `?user_id=${otherUser.user.id}`);
    report('admin can see a DIFFERENT user\'s entries (cross-user view)', byOtherUser.body?.entries?.length === 1 && byOtherUser.body.entries[0].user_id === otherUser.user.id, JSON.stringify(byOtherUser.body));

    const futureFrom = new Date(Date.now() + 60_000).toISOString();
    const byFutureFrom = await call(adminSession.session, `?user_id=${testUser.user.id}&from=${encodeURIComponent(futureFrom)}`);
    report('a "from" date in the future excludes all seeded entries', byFutureFrom.body?.entries?.length === 0, JSON.stringify(byFutureFrom.body));

    const invalidDate = await call(adminSession.session, `?from=not-a-date`);
    report('an invalid "from" date is rejected', invalidDate.status === 422, JSON.stringify(invalidDate.body));

    const paginated = await call(adminSession.session, `?user_id=${testUser.user.id}&limit=1`);
    report('pagination: limit=1 returns 1 entry with total=2 and hasMore=true', paginated.body?.entries?.length === 1 && paginated.body?.pagination?.total === 2 && paginated.body?.pagination?.hasMore === true, JSON.stringify(paginated.body));
  } finally {
    for (const { auditId } of seeded) await admin.from('step_up_audit_log').delete().eq('id', auditId);
    for (const { approvalId } of seeded) await admin.from('step_up_approvals').delete().eq('id', approvalId);
    await admin.auth.admin.deleteUser(testUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(otherUser.user.id).catch(() => {});
    await admin.auth.admin.deleteUser(adminUser.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll admin audit-log checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
