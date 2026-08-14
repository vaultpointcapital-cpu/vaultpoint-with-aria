# RUNBOOK — Applying the live DB reconciliation

Six migrations (`20260717000000` through `20260717000005`) bring live's actual schema in line with what this repo's migrations have always assumed. This is the deliverable of that reconciliation effort — run this yourself, in a low-traffic window. Nothing in this file has been applied to live by anyone else; every step below is still pending.

**Read this whole file before starting.** Steps are numbered and copy-pasteable, each with the output you should see. Stop and don't proceed if a step's actual output doesn't match what's described — that's the point of checking after each one, not just at the end.

## Before you start

- **No PITR on this tier.** Supabase's point-in-time recovery isn't available on the plan this project is on. The backup you take in step 1 is not a formality — it is the *only* rollback path available if something goes wrong that the down-migrations (in `rollbacks/`) can't cleanly undo. No backup, no surgery.
- Confirm you're in a genuinely low-traffic window. Every migration below is written to be safe against the row counts this reconciliation found (2 rows in `users`, 0 everywhere else touched) — if usage has grown significantly since, re-read the migration files' own header comments before proceeding; a couple of the `NOT NULL`/`CHECK` additions assume that's still roughly true.
- You'll need: `psql` (part of the PostgreSQL client tools — `winget install PostgreSQL.PostgreSQL.17` on Windows, or your platform's equivalent), and the live database's **session pooler** connection string from Supabase Dashboard → Project Settings → Database → Connection string → **Session pooler** tab (not the direct-connection tab — that one is IPv6-only and will likely time out). Export it as `LIVE_DB_URL` in your own shell; don't paste it anywhere else, don't put it in a file in this repo.

```bash
export LIVE_DB_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

---

## 1. Back up live — schema and data

```bash
mkdir -p ~/vaultpoint-backups
pg_dump --no-owner --no-privileges "$LIVE_DB_URL" -f ~/vaultpoint-backups/live_pre_reconcile_$(date +%Y%m%d_%H%M%S).sql
```

**Expected output:** the command completes with no error output, and a new file appears in `~/vaultpoint-backups/`.

## 2. Sanity-check the backup

```bash
ls -la ~/vaultpoint-backups/live_pre_reconcile_*.sql
grep -c "^COPY " ~/vaultpoint-backups/live_pre_reconcile_*.sql
```

**Expected output:** the file is a non-trivial size (schema alone was ~150KB when this reconciliation was scoped; a file a few KB in size means the dump likely failed silently or connected to the wrong database — stop and investigate before continuing). The `grep -c` count should be roughly the number of tables with data — don't worry about the exact number, just confirm it's not 0.

## 3. Re-confirm row counts haven't changed materially

```bash
psql -X -A -t "$LIVE_DB_URL" -c "
select 'users' as t, count(*) from public.users
union all select 'subscriptions', count(*) from public.subscriptions
union all select 'positions', count(*) from public.positions
union all select 'broker_connections', count(*) from public.broker_connections
union all select 'alerts', count(*) from public.alerts
union all select 'autonomous_action_log', count(*) from public.autonomous_action_log
union all select 'execution_authorizations', count(*) from public.execution_authorizations
union all select 'withdrawal_authorizations', count(*) from public.withdrawal_authorizations
order by 1;"
```

**Expected output (as of this reconciliation's own measurement):** `users` = 2, everything else = 0. If any of the three untracked tables (`autonomous_action_log`, `execution_authorizations`, `withdrawal_authorizations`) now has rows where it previously had none, **stop** — migration `20260717000002` drops these tables, and that's no longer a safe default if real data has landed in them since this was scoped. Come back to this runbook after deciding what to do about that data instead of dropping it silently.

## 4. Apply migration `20260717000000` — reconcile `subscriptions`

```bash
cd services/broker-sync  # or wherever your repo root is — path to supabase/migrations/ from here
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f ../../supabase/migrations/20260717000000_reconcile_subscriptions_for_billing.sql
```

(Adjust the relative path to `supabase/migrations/` for wherever you're running this from — or just use the full path to your local clone.)

**Expected output:** a sequence of `ALTER TABLE`, `DO`, `CREATE INDEX IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `COMMENT`, `ALTER TABLE` lines, no `ERROR`.

**Verify:**

```bash
psql -X "$LIVE_DB_URL" -c "\d public.subscriptions"
```

Confirm the output shows `tier`, `payment_provider`, `provider_customer_id`, `updated_at` columns (not `plan`/`provider`), and three `CHECK` constraints (`subscriptions_tier_check`, `subscriptions_payment_provider_check`, `subscriptions_status_check`).

## 5. Apply migration `20260717000001` — reconcile the remaining tables

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f supabase/migrations/20260717000001_reconcile_remaining_tables_with_live.sql
```

**Expected output:** a long sequence of `ALTER TABLE`/`DO`/`UPDATE 0` lines (the `UPDATE 0`s are the safety-net backfills finding nothing to fix, which is correct given the row counts from step 3), no `ERROR`.

**Verify — spot check the four things this reconciliation's own rehearsal caught as bugs before they reached this file:**

```bash
psql -X -A "$LIVE_DB_URL" -c "
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='positions' and column_name='mark_price';

select column_name, is_nullable from information_schema.columns
where table_schema='public' and table_name='broker_connections' and column_name in ('api_key_iv','api_secret_iv');

select column_name, is_nullable from information_schema.columns
where table_schema='public' and table_name='savings_pods' and column_name='created_at';

select column_name, column_default from information_schema.columns
where table_schema='public' and table_name='portfolio_snapshots' and column_name='snapshot_date';
"
```

**Expected output:** `mark_price` is type `numeric` (no precision/scale). Both `api_key_iv` and `api_secret_iv` show `is_nullable = YES`. `savings_pods.created_at` shows `is_nullable = NO`. `portfolio_snapshots.snapshot_date` shows `column_default` as empty/null (no default).

## 6. Apply migration `20260717000002` — drop the unlaunched execution tables

**Re-read this migration file's own header comment before running it** — it explains exactly why these three tables are safe to drop (0 rows, 0 inbound foreign keys, no triggers, no views) and that the pre-surgery backup from step 1 is the rollback if that's ever wrong.

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f supabase/migrations/20260717000002_drop_unlaunched_execution_tables.sql
```

**Expected output:** three `DROP TABLE` lines, no `ERROR`.

**Verify:**

```bash
psql -X -A -t "$LIVE_DB_URL" -c "
select table_name from information_schema.tables
where table_schema='public' and table_name in ('autonomous_action_log','execution_authorizations','withdrawal_authorizations');
"
```

**Expected output:** no rows returned.

## 7. Apply migration `20260717000003` — fix `handle_new_user()`

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f supabase/migrations/20260717000003_fix_handle_new_user_email.sql
```

**Expected output:** a single `CREATE FUNCTION` line, no `ERROR`.

**Verify:**

```bash
psql -X -A "$LIVE_DB_URL" -c "select prosrc from pg_proc where proname = 'handle_new_user';"
```

**Expected output:** the function body text includes `new.email` — confirming the fix (the pre-fix version only inserted `id` and `full_name`, never `email`).

## 8. Apply migration `20260717000004` — `aria_conversations`

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f supabase/migrations/20260717000004_add_aria_conversations.sql
```

**Expected output:** `CREATE TABLE`, `COMMENT` x2, `CREATE INDEX`, `ALTER TABLE`, `CREATE POLICY`, no `ERROR`.

**Verify:**

```bash
psql -X -A -t "$LIVE_DB_URL" -c "select count(*) from information_schema.tables where table_schema='public' and table_name='aria_conversations';"
```

**Expected output:** `1`.

## 9. Apply migration `20260717000005` — alert cooldown + drawdown

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -f supabase/migrations/20260717000005_add_alert_engine_cooldown_and_drawdown.sql
```

**Expected output:** `ALTER TABLE`, `COMMENT`, `ALTER TABLE` x2, no `ERROR`.

**Verify:**

```bash
psql -X -A "$LIVE_DB_URL" -c "
select column_name from information_schema.columns
where table_schema='public' and table_name='alerts' and column_name='last_triggered_at';

select pg_get_constraintdef(oid) from pg_constraint where conname = 'alerts_condition_type_check';
"
```

**Expected output:** `last_triggered_at` present. The constraint definition includes `'drawdown_pct'` in its list of allowed values.

## 10. Validate the deferred constraints from step 4

Migration `20260717000000` added its three `CHECK` constraints as `NOT VALID` — deliberately, since this reconciliation never had read access to live's row-level data, only its schema. Given step 3 confirmed `subscriptions` has 0 rows, these should validate instantly and trivially, but validating explicitly (rather than just leaving them `NOT VALID` forever) closes that loop properly:

```bash
psql -v ON_ERROR_STOP=1 "$LIVE_DB_URL" -c "
alter table public.subscriptions validate constraint subscriptions_tier_check;
alter table public.subscriptions validate constraint subscriptions_payment_provider_check;
alter table public.subscriptions validate constraint subscriptions_status_check;
"
```

**Expected output:** three `ALTER TABLE` lines, no `ERROR`. If this step fails, it means a row exists that violates one of these constraints — the error message will name which row/constraint; fix that row's data before re-running this step (do not drop the constraint to make the error go away).

## 11. Final check

```bash
psql -X -A -t "$LIVE_DB_URL" -c "
select 'users' as t, count(*) from public.users
union all select 'subscriptions', count(*) from public.subscriptions
union all select 'positions', count(*) from public.positions
union all select 'broker_connections', count(*) from public.broker_connections
union all select 'alerts', count(*) from public.alerts
union all select 'aria_conversations', count(*) from public.aria_conversations
order by 1;"
```

**Expected output:** the same row counts as step 3 (this reconciliation only changed shape, not data — except the three dropped tables, which no longer appear at all), plus `aria_conversations` now existing with 0 rows.

You're done. Live's schema now matches this repo's migration stack exactly. From here forward, every schema change ships as a new migration file — see `supabase/README.md`.

---

## Rollback

**Primary rollback: restore from the step 1 backup.**

```bash
psql "$LIVE_DB_URL" -c "drop schema public cascade; create schema public;"
psql "$LIVE_DB_URL" -f ~/vaultpoint-backups/live_pre_reconcile_<timestamp>.sql
```

This is destructive to anything written to live *after* the step 1 backup was taken — that's the actual cost of no PITR on this tier, not a gap in this runbook. If real user activity happened between step 1 and whenever you roll back, that activity is lost by this restore path. Weigh that before choosing to roll back versus fixing forward.

**Secondary option: the per-migration down files in `rollbacks/`.** Faster and non-destructive to unrelated data, but only covers schema, not data recovery — and `20260717000002`'s rollback recreates the three dropped tables empty, it cannot recover rows if any existed at drop time (see that file's own header comment). Use these only if you're rolling back a single specific migration shortly after applying it, not as a substitute for the backup once real usage has occurred against the new schema.
