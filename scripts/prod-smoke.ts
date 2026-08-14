// Production smoke test — automatable checks only, per
// docs/runbooks/pre-launch-prod-verification.md.
//
// IMPORTANT: that runbook does not exist in this repository as of writing
// this script (checked: no docs/runbooks/ directory at all). The six
// checks below come directly from the task description that requested
// this script, not from the runbook file itself — see this repo's PR/
// task history for the exact wording. The "which runbook checks this
// script does NOT cover, and why" deliverable could not be produced for
// the same reason: there is no runbook content to diff against. If the
// runbook exists elsewhere (a wiki, a doc not yet committed), point this
// script's header comment at it and reconcile the two.
//
// SAFETY CONTRACT:
//   - Every credential is read from process.env — nothing is hardcoded.
//   - No secret, API key, or credential is ever printed, logged, or
//     included in a report line — not even partially/masked. Only
//     PASS/FAIL/WARN/SKIP, table/env-var/route NAMES, counts, and
//     non-secret values (timestamps, statuses, row counts) are printed.
//   - The Postgres role behind PROD_SMOKE_DB_URL must be READ-ONLY (SELECT
//     grants only, no INSERT/UPDATE/DELETE on any table) — enforced
//     operationally by how that role is provisioned, not by this script,
//     but this script also never issues a write statement by construction:
//     every query in this file is a SELECT, SET ROLE, or SET
//     (session-local config), never DML. The RLS check's "impersonate a
//     user" technique (SET ROLE authenticated + request.jwt.claims) is
//     the same read-only-compatible mechanism scripts/test-rls-isolation.mjs
//     already established in this repo — see that file's own comments —
//     except this script never runs the write-heavy setup that script
//     does (create test users, insert synthetic rows). It only reads
//     whatever real data already exists in production, which means a
//     table with zero rows (or only one distinct owner) cannot be
//     isolation-tested and is reported SKIP, not PASS — a SKIP is not a
//     substitute for real coverage.
//
// Run with: npx tsx scripts/prod-smoke.ts
// Required env vars are validated per-check; a check whose required env
// vars are missing is reported SKIP (not FAIL — a smoke test that can't
// run isn't the same as one that ran and found a problem), except the
// env var audit itself, which structurally cannot be skipped.

import crypto from 'crypto';
import { Client } from 'pg';
import { Redis } from '@upstash/redis';
import { readFileSync, existsSync } from 'node:fs';

// ============================================================================
// Reporting
// ============================================================================

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

let failures = 0;
let warnings = 0;

function report(section: string, name: string, status: Status, expected: unknown, actual: unknown): void {
  if (status === 'FAIL') failures++;
  if (status === 'WARN') warnings++;
  const pad = status.padEnd(4);
  console.log(`[${pad}] ${section}/${name}  expected=${stringify(expected)} actual=${stringify(actual)}`);
}

function reportSkip(section: string, name: string, reason: string): void {
  console.log(`[SKIP] ${section}/${name}  reason=${reason}`);
}

function stringify(value: unknown): string {
  if (value === undefined) return 'n/a';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ============================================================================
// Config — every credential/URL is read from process.env, nothing hardcoded.
// ============================================================================

const CONFIG = {
  nextjsAppUrl: process.env.PROD_APP_URL,
  brokerSyncHealthUrl: process.env.BROKER_SYNC_HEALTH_URL,
  expectedCommitSha: process.env.EXPECTED_COMMIT_SHA ?? process.env.GITHUB_SHA,
  dbUrl: process.env.PROD_SMOKE_DB_URL,
  encryptionKey: process.env.ENCRYPTION_KEY,
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
};

// ============================================================================
// Check 1 — Health endpoints, with commit-SHA assertion
// ============================================================================

async function checkHealthEndpoints(): Promise<void> {
  section('Health endpoints');

  if (!CONFIG.nextjsAppUrl) {
    reportSkip('health', 'nextjs', 'PROD_APP_URL not set');
  } else {
    await checkOneHealthEndpoint('health/nextjs', `${CONFIG.nextjsAppUrl.replace(/\/$/, '')}/api/health`);
  }

  if (!CONFIG.brokerSyncHealthUrl) {
    reportSkip('health', 'broker-sync', 'BROKER_SYNC_HEALTH_URL not set');
  } else {
    await checkOneHealthEndpoint('health/broker-sync', CONFIG.brokerSyncHealthUrl);
  }
}

async function checkOneHealthEndpoint(label: string, url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    report(label, 'reachable', 'FAIL', 'reachable', `unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  report(label, 'http-status', response.status === 200 ? 'PASS' : 'FAIL', 200, response.status);

  let body: { status?: string; version?: string; checks?: Record<string, unknown> } | null = null;
  try {
    body = await response.json();
  } catch {
    report(label, 'json-body', 'FAIL', 'valid JSON', 'response was not valid JSON');
    return;
  }

  report(label, 'status-field', body?.status === 'ok' ? 'PASS' : 'FAIL', 'ok', body?.status ?? 'missing');

  if (CONFIG.expectedCommitSha) {
    const matches = typeof body?.version === 'string' && body.version.startsWith(CONFIG.expectedCommitSha.slice(0, 7));
    report(label, 'commit-sha', matches ? 'PASS' : 'FAIL', CONFIG.expectedCommitSha, body?.version ?? 'missing');
  } else {
    reportSkip(label, 'commit-sha', 'EXPECTED_COMMIT_SHA/GITHUB_SHA not set — reported version was: ' + (body?.version ?? 'missing'));
  }

  if (body?.checks) {
    for (const [checkName, checkValue] of Object.entries(body.checks)) {
      const ok = typeof checkValue === 'string' && (checkValue === 'ok' || checkValue.startsWith('not configured'));
      report(label, `sub-check.${checkName}`, ok ? 'PASS' : 'WARN', 'ok', checkValue);
    }
  }
}

// ============================================================================
// Check 2 — Cross-account RLS isolation across every RLS-enabled table.
//
// Dynamically enumerates tables (no hardcoded list — this is the only way
// "every table" stays true as the schema grows), splitting into two
// strategies:
//   - Tables with a `user_id` column: verify the owner can read their own
//     row AND a different real user cannot.
//   - Tables without one (assumed admin-only/service-role-only reads):
//     verify a non-admin real user gets zero rows.
// Only ever SELECTs — impersonation is via SET ROLE + a session-local GUC,
// not a data write. See file header for why this differs from
// scripts/test-rls-isolation.mjs (which is intentionally write-heavy and
// shadow-project-only).
// ============================================================================

async function checkRlsIsolation(): Promise<void> {
  section('Cross-account RLS isolation');

  if (!CONFIG.dbUrl) {
    reportSkip('rls', 'all-tables', 'PROD_SMOKE_DB_URL not set');
    return;
  }

  const db = new Client({ connectionString: CONFIG.dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();

  try {
    const tablesResult = await db.query<{ tablename: string }>(
      `select c.relname as tablename
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = true
       order by c.relname`
    );

    if (tablesResult.rows.length === 0) {
      reportSkip('rls', 'all-tables', 'no RLS-enabled tables found in public schema — is PROD_SMOKE_DB_URL pointed at the right database?');
      return;
    }

    const nonAdminUser = await findRealUser(db, { admin: false });
    const adminAwareness = nonAdminUser
      ? null
      : 'no non-admin user found in users table — admin-only-table checks skipped';

    for (const { tablename } of tablesResult.rows) {
      const columnsResult = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [tablename]
      );
      const columns = new Set(columnsResult.rows.map((r) => r.column_name));

      if (columns.has('user_id')) {
        await checkUserOwnedTable(db, tablename);
      } else if (nonAdminUser) {
        await checkAdminOnlyTable(db, tablename, nonAdminUser);
      } else {
        reportSkip(`rls/${tablename}`, 'admin-only-lockdown', adminAwareness ?? 'no non-admin user available');
      }
    }
  } finally {
    await db.end();
  }
}

async function findRealUser(db: Client, opts: { admin: boolean }): Promise<string | null> {
  const result = await db.query<{ id: string }>(`select id from public.users where is_admin = $1 limit 1`, [opts.admin]);
  return result.rows[0]?.id ?? null;
}

async function asUser<T>(db: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [userId]);
    return await fn();
  } finally {
    // Always rolled back — this transaction never contains a write, but
    // rollback (not commit) is used unconditionally anyway so a future
    // edit to this function can't accidentally start persisting anything.
    await db.query('rollback');
  }
}

async function checkUserOwnedTable(db: Client, table: string): Promise<void> {
  const ownersResult = await db.query<{ user_id: string }>(
    `select distinct user_id from public.${quoteIdent(table)} where user_id is not null limit 2`
  );
  const owners = ownersResult.rows.map((r) => r.user_id);

  if (owners.length < 2) {
    reportSkip(`rls/${table}`, 'owner-vs-stranger', `fewer than 2 distinct owners with data (found ${owners.length}) — nothing to isolation-test yet`);
    return;
  }

  // Non-null: the `owners.length < 2` guard above already proves both
  // indices exist — noUncheckedIndexedAccess can't see that invariant
  // through the early return.
  const ownerA = owners[0]!;
  const ownerB = owners[1]!;

  const ownerRowResult = await db.query<{ id: string }>(
    `select id from public.${quoteIdent(table)} where user_id = $1 limit 1`,
    [ownerA]
  );
  const rowId = ownerRowResult.rows[0]?.id;
  if (!rowId) {
    reportSkip(`rls/${table}`, 'owner-vs-stranger', 'could not resolve a row id column named "id" for this table — skipping (see script limitations)');
    return;
  }

  const ownRead = await asUser(db, ownerA, () =>
    db.query(`select id from public.${quoteIdent(table)} where id = $1`, [rowId])
  );
  if (ownRead.rows.length === 0) {
    // Not a leak — the dangerous direction is a STRANGER reading, not the
    // owner being blocked. This just means the table may be admin-only
    // despite having a user_id column (e.g. an "attributed to" column
    // rather than an "owned by" one) — flagged for a human, not a FAIL.
    report(`rls/${table}`, 'owner-can-read-own-row', 'WARN', '>=1 row', '0 rows — table may not have an owner-read policy despite having user_id');
  } else {
    report(`rls/${table}`, 'owner-can-read-own-row', 'PASS', '>=1 row', `${ownRead.rows.length} row(s)`);
  }

  const strangerRead = await asUser(db, ownerB, () =>
    db.query(`select id from public.${quoteIdent(table)} where id = $1`, [rowId])
  );
  report(
    `rls/${table}`,
    'stranger-cannot-read-others-row',
    strangerRead.rows.length === 0 ? 'PASS' : 'FAIL',
    '0 rows',
    `${strangerRead.rows.length} row(s)`
  );
}

async function checkAdminOnlyTable(db: Client, table: string, nonAdminUserId: string): Promise<void> {
  const anyRowResult = await db.query(`select 1 from public.${quoteIdent(table)} limit 1`);
  if (anyRowResult.rows.length === 0) {
    reportSkip(`rls/${table}`, 'non-admin-locked-out', 'table is empty — nothing to isolation-test yet');
    return;
  }

  const asNonAdmin = await asUser(db, nonAdminUserId, () => db.query(`select 1 from public.${quoteIdent(table)} limit 1`));
  report(
    `rls/${table}`,
    'non-admin-locked-out',
    asNonAdmin.rows.length === 0 ? 'PASS' : 'FAIL',
    '0 rows',
    `${asNonAdmin.rows.length} row(s)`
  );
}

/** Defends against a malicious/malformed table name reaching raw SQL — pg_class only ever gives us real table names, but this is cheap insurance. */
function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Refusing to interpolate suspicious identifier: ${identifier}`);
  }
  return identifier;
}

// ============================================================================
// Check 3 — Portfolio reconciliation against the broker API.
//
// Bybit only. Verified against the real, existing implementation
// (services/broker-sync/app/brokers/bybit.py) — same endpoint, same
// request-signing formula, same params — so this is a faithful
// reconciliation, not a guess at a different vendor contract. MetaTrader/
// Binance/KuCoin are NOT implemented here — their exact request-signing
// details weren't re-verified with the same confidence for this pass;
// extend this function per-broker following the same
// "read the real client implementation, mirror it exactly" method rather
// than guessing.
// ============================================================================

async function checkPortfolioReconciliation(): Promise<void> {
  section('Portfolio reconciliation (Bybit)');

  if (!CONFIG.dbUrl) {
    reportSkip('reconcile', 'bybit', 'PROD_SMOKE_DB_URL not set');
    return;
  }
  if (!CONFIG.encryptionKey) {
    reportSkip('reconcile', 'bybit', 'ENCRYPTION_KEY not set — cannot decrypt broker credentials');
    return;
  }

  const db = new Client({ connectionString: CONFIG.dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();

  try {
    const connectionResult = await db.query<{
      id: string;
      encrypted_api_key: string;
      api_key_iv: string;
      encrypted_api_secret: string;
      api_secret_iv: string;
    }>(
      `select id, encrypted_api_key, api_key_iv, encrypted_api_secret, api_secret_iv
       from public.broker_connections
       where broker = 'bybit' and health = 'healthy' and encrypted_api_key is not null
       order by last_success_at desc nulls last
       limit 1`
    );

    const connection = connectionResult.rows[0];
    if (!connection) {
      reportSkip('reconcile', 'bybit', 'no healthy Bybit connection found to sample');
      return;
    }

    const apiKey = decrypt(connection.encrypted_api_key, connection.api_key_iv, CONFIG.encryptionKey);
    const apiSecret = decrypt(connection.encrypted_api_secret, connection.api_secret_iv, CONFIG.encryptionKey);

    let brokerPositions: BybitPosition[];
    try {
      brokerPositions = await fetchBybitPositions(apiKey, apiSecret);
    } catch (err) {
      report('reconcile/bybit', 'broker-api-call', 'FAIL', 'success', `error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    report('reconcile/bybit', 'broker-api-call', 'PASS', 'success', `${brokerPositions.length} open position(s)`);

    const cachedResult = await db.query<{ symbol: string; side: string; size: string }>(
      `select symbol, side, size from public.positions where broker_connection_id = $1`,
      [connection.id]
    );

    const brokerBySymbolSide = new Map(brokerPositions.map((p) => [`${p.symbol}:${p.side}`, p.size]));
    const cachedBySymbolSide = new Map(cachedResult.rows.map((p) => [`${p.symbol}:${p.side}`, Number(p.size)]));

    const allKeys = new Set([...brokerBySymbolSide.keys(), ...cachedBySymbolSide.keys()]);
    if (allKeys.size === 0) {
      report('reconcile/bybit', 'position-count-match', 'PASS', 0, 0);
      return;
    }

    let mismatches = 0;
    for (const key of allKeys) {
      const brokerSize = brokerBySymbolSide.get(key) ?? 0;
      const cachedSize = cachedBySymbolSide.get(key) ?? 0;
      const withinTolerance = Math.abs(brokerSize - cachedSize) < 0.0001;
      if (!withinTolerance) {
        mismatches++;
        report('reconcile/bybit', `position.${key}`, 'FAIL', brokerSize, cachedSize);
      }
    }
    if (mismatches === 0) {
      report('reconcile/bybit', 'all-positions-match', 'PASS', `${allKeys.size} position(s)`, `${allKeys.size} position(s) matched`);
    }
  } finally {
    await db.end();
  }
}

interface BybitPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
}

async function fetchBybitPositions(apiKey: string, apiSecret: string): Promise<BybitPosition[]> {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const params = { category: 'linear', settleCoin: 'USDT' };
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(`${timestamp}${apiKey}${recvWindow}${queryString}`)
    .digest('hex');

  const response = await fetch(`https://api.bybit.com/v5/position/list?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': recvWindow,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Bybit API returned HTTP ${response.status}`);
  }
  interface BybitPositionRow {
    symbol: string;
    side: 'Buy' | 'Sell';
    size: string;
  }
  const body = (await response.json()) as { retCode: number; retMsg: string; result: { list: BybitPositionRow[] } };
  if (body.retCode !== 0) {
    throw new Error(`Bybit API error ${body.retCode}: ${body.retMsg}`);
  }

  return body.result.list
    .filter((row) => parseFloat(row.size) !== 0)
    .map((row) => ({
      symbol: row.symbol,
      side: (row.side === 'Buy' ? 'long' : 'short') as 'long' | 'short',
      size: parseFloat(row.size),
    }));
}

function decrypt(ciphertextHex: string, ivHex: string, encryptionKeyHex: string): string {
  // Byte-for-byte the same algorithm as src/lib/encryption/broker-keys.ts
  // — reimplemented inline (not imported) so this standalone script has
  // no dependency on src/'s module structure or path aliases.
  const key = Buffer.from(encryptionKeyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const combined = Buffer.from(ciphertextHex, 'hex');
  const AUTH_TAG_LENGTH = 16;
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ============================================================================
// Check 4 — Stale-cache behaviour.
//
// Confirms cache entries this codebase writes actually carry an expiry
// (so stale data can't accumulate forever), and cross-checks the poll
// heartbeat's own freshness against the staleness threshold
// services/broker-sync/app/main.py's /health already enforces
// (POLL_STALE_MULTIPLIER = 3) — two different failure modes: "is the
// cache configured to expire" vs. "is the job that fills it still running
// on schedule."
// ============================================================================

async function checkStaleCacheBehaviour(): Promise<void> {
  section('Stale-cache behaviour');

  if (!CONFIG.upstashUrl || !CONFIG.upstashToken) {
    reportSkip('cache', 'upstash', 'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set');
    return;
  }
  if (!CONFIG.dbUrl) {
    reportSkip('cache', 'positions-keys', 'PROD_SMOKE_DB_URL not set — cannot sample which connection ids to check');
    return;
  }

  const redis = new Redis({ url: CONFIG.upstashUrl, token: CONFIG.upstashToken });

  const db = new Client({ connectionString: CONFIG.dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let connectionIds: string[] = [];
  try {
    const result = await db.query<{ id: string }>(
      `select id from public.broker_connections where health = 'healthy' order by last_success_at desc nulls last limit 5`
    );
    connectionIds = result.rows.map((r) => r.id);
  } finally {
    await db.end();
  }

  if (connectionIds.length === 0) {
    reportSkip('cache', 'positions-keys', 'no healthy broker connections found to sample cache keys for');
    return;
  }

  const MAX_EXPECTED_TTL_SECONDS = 120; // generous ceiling above config.py's default cache_ttl_seconds=55
  let sampled = 0;

  for (const connectionId of connectionIds) {
    const key = `positions:${connectionId}`;
    const ttl = await redis.ttl(key);

    if (ttl === -2) {
      // Key doesn't exist — could mean this connection hasn't synced
      // since the cache was last cleared, not necessarily a bug.
      reportSkip(`cache/${key.split(':')[0]}`, connectionId.slice(0, 8), 'cache key does not currently exist for this connection');
      continue;
    }
    sampled++;

    if (ttl === -1) {
      report('cache/positions', `${connectionId.slice(0, 8)}.has-expiry`, 'FAIL', 'TTL set', 'no expiry (persists forever)');
    } else if (ttl > MAX_EXPECTED_TTL_SECONDS) {
      report('cache/positions', `${connectionId.slice(0, 8)}.ttl-within-bounds`, 'FAIL', `<= ${MAX_EXPECTED_TTL_SECONDS}s`, `${ttl}s`);
    } else {
      report('cache/positions', `${connectionId.slice(0, 8)}.ttl-within-bounds`, 'PASS', `<= ${MAX_EXPECTED_TTL_SECONDS}s`, `${ttl}s`);
    }
  }

  if (sampled === 0) {
    reportSkip('cache', 'positions-keys', 'none of the sampled connection ids currently have a cache entry');
  }

  // Poll heartbeat freshness — same threshold broker-sync's own /health
  // computes (poll_interval_seconds * 3), read from that endpoint rather
  // than re-deriving the interval here, so this can never silently drift
  // out of sync with the real enforcement logic.
  if (CONFIG.brokerSyncHealthUrl) {
    try {
      const res = await fetch(CONFIG.brokerSyncHealthUrl, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { checks?: { last_successful_poll?: string; last_successful_poll_stale?: boolean } };
      const stale = body.checks?.last_successful_poll_stale === true;
      report('cache/poll-heartbeat', 'not-stale', stale ? 'FAIL' : 'PASS', 'not stale', stale ? 'stale' : 'fresh');
    } catch (err) {
      report('cache/poll-heartbeat', 'not-stale', 'FAIL', 'reachable', `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    reportSkip('cache', 'poll-heartbeat', 'BROKER_SYNC_HEALTH_URL not set');
  }
}

// ============================================================================
// Check 5 — Env var audit.
//
// Parses .env.example for the full documented list (source of truth for
// "vars this app might read"), checks presence (never value) in the
// current environment. CRITICAL_VARS is a deliberately small, explicit
// allowlist of vars whose absence breaks core app functionality (auth,
// DB, encryption, cron) — everything else in .env.example is reported
// WARN when missing, not FAIL, because this codebase's own .env.example
// comments document many of them as intentionally unset pending a vendor
// decision (Cobo, Onfido/VerifyMe, Flutterwave) — see that file.
// ============================================================================

const CRITICAL_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'PYTHON_SERVICE_URL',
  'PYTHON_SERVICE_API_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'STEP_UP_JWT_SECRET',
  'CRON_SECRET',
  'NEXT_PUBLIC_APP_URL',
];

async function checkEnvVarAudit(): Promise<void> {
  section('Env var audit');

  const envExamplePath = '.env.example';
  if (!existsSync(envExamplePath)) {
    report('env', 'env-example-exists', 'FAIL', envExamplePath, 'not found — run from the repo root');
    return;
  }

  const documentedVars = readFileSync(envExamplePath, 'utf8')
    .split('\n')
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter((name): name is string => Boolean(name));

  for (const name of documentedVars) {
    const isSet = Boolean(process.env[name]?.length);
    const isCritical = CRITICAL_VARS.includes(name);

    if (isSet) {
      report('env', name, 'PASS', 'set', 'set');
    } else if (isCritical) {
      report('env', name, 'FAIL', 'set', 'MISSING (critical)');
    } else {
      report('env', name, 'WARN', 'set', 'not set (may be intentional — see .env.example)');
    }
  }

  const undocumentedCritical = CRITICAL_VARS.filter((name) => !documentedVars.includes(name));
  for (const name of undocumentedCritical) {
    report('env', name, process.env[name] ? 'PASS' : 'FAIL', 'set', process.env[name] ? 'set' : 'MISSING (critical, and undocumented in .env.example)');
  }
}

// ============================================================================
// Check 6 — Webhook URL verification.
//
// For each known webhook route: (a) confirm its signing secret env var is
// present (an unset secret means the route would either reject
// everything or, worse, has a code path that skips verification — either
// way worth knowing before launch), (b) POST a dummy payload with NO
// valid signature and confirm the route rejects it (400/401), proving
// signature verification is actually being enforced in production rather
// than accidentally bypassed. Never computes a real signature — this
// check doesn't need the actual secret value, only its presence.
// ============================================================================

interface WebhookSpec {
  path: string;
  secretEnvVar: string | null;
}

const WEBHOOKS: WebhookSpec[] = [
  { path: '/api/webhooks/stripe', secretEnvVar: 'STRIPE_WEBHOOK_SECRET' },
  { path: '/api/webhooks/paystack', secretEnvVar: 'PAYSTACK_SECRET_KEY' },
  { path: '/api/webhooks/flutterwave', secretEnvVar: 'FLUTTERWAVE_WEBHOOK_SECRET_HASH' },
  { path: '/api/webhooks/telegram/updates', secretEnvVar: 'TELEGRAM_WEBHOOK_SECRET' },
  { path: '/api/webhooks/web3', secretEnvVar: 'WEB3_OFFRAMP_WEBHOOK_SECRET' },
  { path: '/api/webhooks/kyc/onfido', secretEnvVar: 'ONFIDO_WEBHOOK_TOKEN' },
  { path: '/api/webhooks/kyc/verifyme', secretEnvVar: 'VERIFYME_WEBHOOK_SECRET' },
];

async function checkWebhookUrls(): Promise<void> {
  section('Webhook URL verification');

  if (!CONFIG.nextjsAppUrl) {
    reportSkip('webhooks', 'all', 'PROD_APP_URL not set');
    return;
  }

  for (const webhook of WEBHOOKS) {
    const label = `webhooks${webhook.path.replace(/\//g, '.')}`;

    if (webhook.secretEnvVar) {
      const isSet = Boolean(process.env[webhook.secretEnvVar]?.length);
      report(label, 'secret-configured', isSet ? 'PASS' : 'WARN', 'set', isSet ? 'set' : 'not set');
    }

    const url = `${CONFIG.nextjsAppUrl.replace(/\/$/, '')}${webhook.path}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prod_smoke_test: true, note: 'intentionally invalid signature — expecting rejection' }),
        signal: AbortSignal.timeout(15_000),
      });

      const rejectsInvalidSignature = response.status === 400 || response.status === 401;
      report(
        label,
        'rejects-invalid-signature',
        rejectsInvalidSignature ? 'PASS' : 'FAIL',
        '400 or 401',
        response.status
      );
    } catch (err) {
      report(label, 'reachable', 'FAIL', 'reachable', `unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('VaultPoint production smoke test\n');
  console.log('NOTE: docs/runbooks/pre-launch-prod-verification.md does not exist in this');
  console.log('repository — the six checks below come from the task description that');
  console.log('requested this script, not from that file. See this script\'s header comment.');

  await checkHealthEndpoints();
  await checkRlsIsolation();
  await checkPortfolioReconciliation();
  await checkStaleCacheBehaviour();
  await checkEnvVarAudit();
  await checkWebhookUrls();

  console.log(`\n${failures} failure(s), ${warnings} warning(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('prod-smoke.ts crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
