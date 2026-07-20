// Automated cross-user RLS isolation test — the "launch blocker" item
// from the production-readiness audit: RLS policies exist and read
// correctly (see the migration files), but nothing anywhere actually
// PROVES, against a real Postgres connection, that user B's JWT cannot
// read user A's rows. Every existing test in this repo mocks the
// Supabase client — none of them exercise real RLS enforcement.
//
// Usage: node scripts/test-rls-isolation.mjs
// Requires SHADOW_DB_URL, SHADOW_SUPABASE_URL, and
// SHADOW_SUPABASE_SERVICE_ROLE_KEY in .env.local (or the real env) — the
// shadow project's OWN Admin API credentials, not the live app's
// NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY. Those point at a
// different Supabase project than SHADOW_DB_URL connects to; mixing them
// means the Admin API creates users/rows in one database while the raw
// Postgres connection queries a different one — every row and user
// looks "missing" even though nothing is actually wrong (this is
// exactly the bug that produced this comment: the first version of this
// script used the live credentials and every owner-read check failed
// until this was caught). Runs ONLY against the shadow project — never
// point this at production connection strings; it creates and deletes
// real auth.users rows.
//
// Method: two real test users are created via the Supabase Admin API
// (not hand-crafted auth.users rows — that schema has too many required
// fields to safely fake, and the Admin API is the same path the app's
// own signup route uses). A service-role client (bypasses RLS, matching
// how the app itself writes these tables) inserts one row per table,
// owned by user A. Then a raw Postgres connection simulates user B's
// RLS-scoped session (SET ROLE authenticated + request.jwt.claims,
// same technique used for shadow migration rehearsals throughout this
// project) and asserts user B gets ZERO rows back. Also asserts user A
// CAN read their own row, so a passing "isolation" result can't be
// masqueraded by RLS blocking everyone, including the owner.
//
// Covers the highest-risk tables by policy pattern, not every table —
// broker_connections (encrypted credentials), positions (live financial
// data), subscriptions (billing), signal_actions (financial + has both
// SELECT and INSERT policies to check). The same technique extends
// directly to any other user-owned table.
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const SHADOW_DB_URL = process.env.SHADOW_DB_URL;
const SUPABASE_URL = process.env.SHADOW_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY;

if (!SHADOW_DB_URL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SHADOW_DB_URL / SHADOW_SUPABASE_URL / SHADOW_SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
// The real safety property: this script only ever reads the
// SHADOW_DB_URL-named variable, never LIVE_DB_URL — by construction, not
// by pattern-matching the URL's contents (connection string formats vary
// too much for a substring check to be a meaningful guard).

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const pg = new Client({ connectionString: SHADOW_DB_URL, ssl: { rejectUnauthorized: false } });

let failures = 0;

function report(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

async function asUser(userId, fn) {
  await pg.query('begin');
  try {
    await pg.query('set local role authenticated');
    await pg.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true);`, [userId]);
    return await fn();
  } finally {
    await pg.query('rollback');
  }
}

async function createTestUser(email) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'RlsTest!2026x', email_confirm: true });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function deleteTestUser(userId) {
  await admin.auth.admin.deleteUser(userId).catch(() => {});
}

async function testTable({ name, insertRow, select = 'id' }) {
  console.log(`\n${name}`);
  const { data: inserted, error: insertError } = await admin.from(name).insert(insertRow).select(select).single();
  if (insertError) {
    report(`setup insert for ${name}`, false);
    console.error('   ', insertError.message);
    return;
  }

  const rowId = inserted.id;

  const ownerRows = await asUser(insertRow.user_id, async () => {
    const res = await pg.query(`select id from public.${name} where id = $1`, [rowId]);
    return res.rows;
  });
  report(`owner (user A) CAN read their own ${name} row`, ownerRows.length === 1);

  const strangerId = await createTestUser(`rls-test-stranger-${Date.now()}@example.invalid`);
  try {
    const strangerRows = await asUser(strangerId, async () => {
      const res = await pg.query(`select id from public.${name} where id = $1`, [rowId]);
      return res.rows;
    });
    report(`stranger (user B) CANNOT read user A's ${name} row`, strangerRows.length === 0);
  } finally {
    await deleteTestUser(strangerId);
  }

  await admin.from(name).delete().eq('id', rowId);
}

async function main() {
  await pg.connect();

  const userAId = await createTestUser(`rls-test-owner-${Date.now()}@example.invalid`);

  try {
    await testTable({
      name: 'broker_connections',
      insertRow: {
        user_id: userAId,
        broker: 'bybit',
        label: 'RLS test connection',
        encrypted_api_key: 'ciphertext',
        api_key_iv: 'iv',
        encrypted_api_secret: 'ciphertext',
        api_secret_iv: 'iv',
        is_read_only: true,
        sync_status: 'pending',
      },
    });

    const { data: connection } = await admin
      .from('broker_connections')
      .insert({
        user_id: userAId,
        broker: 'bybit',
        label: 'RLS test connection for positions',
        encrypted_api_key: 'ciphertext',
        api_key_iv: 'iv',
        encrypted_api_secret: 'ciphertext',
        api_secret_iv: 'iv',
        is_read_only: true,
        sync_status: 'connected',
      })
      .select('id')
      .single();

    await testTable({
      name: 'positions',
      insertRow: {
        user_id: userAId,
        broker_connection_id: connection.id,
        symbol: 'BTCUSDT',
        side: 'long',
        size: 0.01,
        entry_price: 65000,
      },
    });

    await admin.from('broker_connections').delete().eq('id', connection.id);

    await testTable({
      name: 'subscriptions',
      insertRow: {
        user_id: userAId,
        payment_provider: 'stripe',
        provider_subscription_id: `sub_rls_test_${Date.now()}`,
        tier: 'pro',
        status: 'active',
      },
    });

    const { data: signal } = await admin
      .from('signals')
      .insert({
        pair: 'BTCUSDT',
        direction: 'long',
        entry_price: 65000,
        stop_loss: 63000,
        take_profit: 70000,
        risk_reward_ratio: 2.5,
        rationale: 'RLS test signal',
        confidence: 'high',
        min_tier: 'pro',
        status: 'active',
      })
      .select('id')
      .single();

    await testTable({
      name: 'signal_actions',
      insertRow: {
        signal_id: signal.id,
        user_id: userAId,
        action: 'skipped',
      },
    });

    await admin.from('signals').delete().eq('id', signal.id);
  } finally {
    await deleteTestUser(userAId);
    await pg.end();
  }

  console.log(`\n${failures === 0 ? 'All RLS isolation checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
