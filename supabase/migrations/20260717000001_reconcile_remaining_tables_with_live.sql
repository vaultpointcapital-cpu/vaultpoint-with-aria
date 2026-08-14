-- ============================================================================
-- VaultPoint — Reconcile remaining public-schema tables with live
-- ============================================================================
-- Continuation of 20260717000000_reconcile_subscriptions_for_billing.sql.
-- Same method: ALTER against live's actual current shape, not CREATE TABLE,
-- for the same reason — every table below already exists in live with a
-- different definition than this repo's migrations ever produced.
--
-- Idempotent by design, same rationale as the subscriptions migration:
-- every RENAME COLUMN is guarded (skipped if the target name already
-- exists), every ADD COLUMN/DROP COLUMN uses IF [NOT] EXISTS, and every
-- constraint is dropped-then-re-added rather than assumed absent. This
-- lets the file run safely against live's current (old) shape, an
-- already-reconciled database, or a brand-new project built straight
-- from the migration stack — required for the CI migration dry-run job
-- to not break the first time this merges. Verified by rehearsal:
-- rebuilt a scratch project to mirror live's exact current shape, ran
-- both migrations against it, and confirmed the resulting schema matches
-- this file's target column-by-column.
--
-- Safe to apply directly (no NOT VALID hedging needed, unlike the
-- subscriptions migration): a live row-count check confirmed every table
-- touched below has 0 rows except users (2 rows). Specifics called out
-- per table.
--
-- Two findings surfaced while writing this that are worth your attention
-- beyond "the columns didn't match":
--
-- 1. SECURITY: live's broker_connections has a single `encryption_iv`
--    column shared by both encrypted_api_key and encrypted_api_secret —
--    i.e. the same IV would have been reused across two different
--    ciphertexts encrypted with the same key. Reusing an IV under AES-GCM
--    is a real cryptographic weakness (can lead to authentication-tag
--    forgery and plaintext recovery), not a cosmetic issue. No actual
--    broker_connections rows exist yet (0 rows), so nothing is
--    compromised today, but this table's *shape* would have produced
--    vulnerable ciphertexts the moment a real connection was saved.
--    Reconciled below to two separate IV columns, matching how
--    src/lib/encryption/broker-keys.ts already generates a fresh IV per
--    encrypt() call.
--
-- 2. SAFETY: live's broker_connections has no is_read_only column at
--    all. This repo's schema comment for that column says "enforced UX:
--    platform never trades" — on live, that guarantee didn't exist at
--    the database level. Added below, default true.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
-- email and metaapi_account_id are kept, not dropped — the target schema
-- in 20260617000000_initial_schema.sql omits both, but nothing in this
-- reconciliation effort establishes that's intentional rather than an
-- oversight in that migration, and dropping a NOT NULL column with real
-- data (2 existing users) on a guess is not a call this migration should
-- make unilaterally.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'country') then
    alter table public.users rename column country to country_code;
  end if;
end $$;

update public.users set onboarding_completed = false where onboarding_completed is null;
alter table public.users alter column onboarding_completed set not null;
update public.users set created_at = now() where created_at is null;
alter table public.users alter column created_at set not null;
update public.users set updated_at = now() where updated_at is null;
alter table public.users alter column updated_at set not null;

alter table public.users add column if not exists subscription_tier text default 'free' not null;
alter table public.users drop constraint if exists users_subscription_tier_check;
alter table public.users
  add constraint users_subscription_tier_check
  check (subscription_tier in ('free', 'pro', 'elite'));

alter table public.users add column if not exists academy_student boolean default false not null;

-- ----------------------------------------------------------------------------
-- positions
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'quantity') then
    alter table public.positions rename column quantity to size;
  end if;
end $$;
alter table public.positions alter column size type numeric;
alter table public.positions alter column size set not null;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'current_price') then
    alter table public.positions rename column current_price to mark_price;
  end if;
end $$;
alter table public.positions alter column mark_price type numeric;

alter table public.positions alter column entry_price type numeric;
alter table public.positions alter column entry_price set not null;

alter table public.positions alter column unrealized_pnl type numeric;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'updated_at') then
    alter table public.positions rename column updated_at to synced_at;
  end if;
end $$;
alter table public.positions alter column synced_at set default now();
alter table public.positions alter column synced_at set not null;

alter table public.positions add column if not exists leverage numeric default 1;
alter table public.positions add column if not exists unrealized_pnl_pct numeric;
alter table public.positions add column if not exists margin_used numeric;

alter table public.positions drop constraint if exists positions_side_check;
alter table public.positions
  add constraint positions_side_check
  check (side = any (array['long'::text, 'short'::text, 'buy'::text, 'sell'::text]));

-- ----------------------------------------------------------------------------
-- alerts
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'alerts' and column_name = 'threshold_value') then
    alter table public.alerts rename column threshold_value to threshold;
  end if;
end $$;
alter table public.alerts alter column threshold type numeric;

alter table public.alerts add column if not exists operator text;
update public.alerts set operator = 'above' where operator is null; -- no rows exist; safety net if that changes before this runs
alter table public.alerts alter column operator set not null;
alter table public.alerts drop constraint if exists alerts_operator_check;
alter table public.alerts
  add constraint alerts_operator_check check (operator = any (array['above'::text, 'below'::text]));

alter table public.alerts alter column is_active set not null;
update public.alerts set created_at = now() where created_at is null;
alter table public.alerts alter column created_at set not null;

alter table public.alerts drop constraint if exists alerts_condition_type_check;
alter table public.alerts
  add constraint alerts_condition_type_check
  check (condition_type = any (array['price'::text, 'pnl_pct'::text, 'pnl_abs'::text, 'margin_pct'::text]));

-- ----------------------------------------------------------------------------
-- alert_history
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'alert_history' and column_name = 'triggered_at') then
    alter table public.alert_history rename column triggered_at to created_at;
  end if;
end $$;
alter table public.alert_history alter column triggered_value type numeric;
alter table public.alert_history alter column triggered_value set not null;
alter table public.alert_history alter column message set not null;
alter table public.alert_history alter column created_at set not null;
alter table public.alert_history add column if not exists delivered_via text[] default '{}'::text[] not null;

-- ----------------------------------------------------------------------------
-- broker_connections — see security/safety notes at the top of this file.
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'broker_connections' and column_name = 'broker_name') then
    alter table public.broker_connections rename column broker_name to broker;
  end if;
end $$;
alter table public.broker_connections drop constraint if exists broker_connections_broker_check;
alter table public.broker_connections
  add constraint broker_connections_broker_check
  check (broker = any (array['bybit'::text, 'binance'::text, 'kucoin'::text, 'metatrader'::text]));

alter table public.broker_connections alter column label set not null;

alter table public.broker_connections alter column encrypted_api_key drop not null;
alter table public.broker_connections alter column encrypted_api_secret drop not null;

-- encryption_iv -> api_key_iv is a rename; api_secret_iv is a new column,
-- not derived from encryption_iv — see the shared-IV note at the top of
-- this file for why they must not both point at the same value.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'broker_connections' and column_name = 'encryption_iv') then
    alter table public.broker_connections rename column encryption_iv to api_key_iv;
  end if;
end $$;
alter table public.broker_connections alter column api_key_iv drop not null;
alter table public.broker_connections add column if not exists api_secret_iv text;

alter table public.broker_connections add column if not exists is_read_only boolean default true not null;
alter table public.broker_connections add column if not exists sync_status text default 'pending' not null;
alter table public.broker_connections drop constraint if exists broker_connections_sync_status_check;
alter table public.broker_connections
  add constraint broker_connections_sync_status_check
  check (sync_status = any (array['pending'::text, 'connected'::text, 'error'::text, 'disconnected'::text]));
alter table public.broker_connections add column if not exists last_error text;
alter table public.broker_connections add column if not exists updated_at timestamptz default now() not null;

alter table public.broker_connections add column if not exists encrypted_api_passphrase text;
alter table public.broker_connections add column if not exists api_passphrase_iv text;
alter table public.broker_connections drop constraint if exists broker_connections_kucoin_requires_passphrase;
alter table public.broker_connections
  add constraint broker_connections_kucoin_requires_passphrase
  check (broker <> 'kucoin' or (encrypted_api_passphrase is not null and api_passphrase_iv is not null));

alter table public.broker_connections add column if not exists mt_login text;
alter table public.broker_connections add column if not exists mt_server text;
alter table public.broker_connections add column if not exists mt_platform text;
alter table public.broker_connections drop constraint if exists broker_connections_mt_platform_check;
alter table public.broker_connections
  add constraint broker_connections_mt_platform_check check (mt_platform = any (array['mt4'::text, 'mt5'::text]));
alter table public.broker_connections add column if not exists encrypted_mt_password text;
alter table public.broker_connections add column if not exists mt_password_iv text;
alter table public.broker_connections add column if not exists metaapi_account_id text;
alter table public.broker_connections add column if not exists metaapi_region text;

alter table public.broker_connections drop constraint if exists broker_connections_metatrader_requires_mt_credentials;
alter table public.broker_connections
  add constraint broker_connections_metatrader_requires_mt_credentials
  check (
    broker <> 'metatrader'
    or (mt_login is not null and mt_server is not null and mt_platform is not null
        and encrypted_mt_password is not null and mt_password_iv is not null)
  );
alter table public.broker_connections drop constraint if exists broker_connections_non_metatrader_requires_api_credentials;
alter table public.broker_connections
  add constraint broker_connections_non_metatrader_requires_api_credentials
  check (
    broker = 'metatrader'
    or (encrypted_api_key is not null and encrypted_api_secret is not null
        and api_key_iv is not null and api_secret_iv is not null)
  );

-- ----------------------------------------------------------------------------
-- manual_assets
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'manual_assets' and column_name = 'name') then
    alter table public.manual_assets rename column name to label;
  end if;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'manual_assets' and column_name = 'value_usd') then
    alter table public.manual_assets rename column value_usd to value;
  end if;
end $$;
alter table public.manual_assets alter column value type numeric;

alter table public.manual_assets add column if not exists asset_type text;
update public.manual_assets set asset_type = 'other' where asset_type is null; -- no rows exist
alter table public.manual_assets alter column asset_type set not null;
alter table public.manual_assets drop constraint if exists manual_assets_asset_type_check;
alter table public.manual_assets
  add constraint manual_assets_asset_type_check
  check (asset_type = any (array['bank'::text, 'property'::text, 'other'::text]));

alter table public.manual_assets add column if not exists currency text default 'USD' not null;
alter table public.manual_assets add column if not exists created_at timestamptz default now() not null;
alter table public.manual_assets alter column updated_at set not null;

-- ----------------------------------------------------------------------------
-- savings_pods
-- ----------------------------------------------------------------------------
alter table public.savings_pods alter column target_amount type numeric;
alter table public.savings_pods drop constraint if exists savings_pods_target_amount_check;
alter table public.savings_pods
  add constraint savings_pods_target_amount_check check (target_amount > (0)::numeric);

alter table public.savings_pods alter column current_amount type numeric;
alter table public.savings_pods alter column current_amount set not null;
alter table public.savings_pods drop constraint if exists savings_pods_current_amount_check;
alter table public.savings_pods
  add constraint savings_pods_current_amount_check check (current_amount >= (0)::numeric);

alter table public.savings_pods alter column currency set not null;
update public.savings_pods set created_at = now() where created_at is null;
alter table public.savings_pods alter column created_at set not null;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'savings_pods' and column_name = 'target_date') then
    alter table public.savings_pods rename column target_date to deadline;
  end if;
end $$;
alter table public.savings_pods add column if not exists color text default '#6C63FF'::text not null;
alter table public.savings_pods add column if not exists updated_at timestamptz default now() not null;

-- is_completed (boolean) is fully superseded by status (active/completed/
-- archived) — dropped rather than kept alongside, to avoid two
-- disagreeing "is this pod done" signals. Safe with 0 existing rows;
-- would need a data-preserving CASE-based backfill instead of a drop if
-- this table had real data.
alter table public.savings_pods add column if not exists status text default 'active' not null;
alter table public.savings_pods drop constraint if exists savings_pods_status_check;
alter table public.savings_pods
  add constraint savings_pods_status_check
  check (status = any (array['active'::text, 'completed'::text, 'archived'::text]));
alter table public.savings_pods drop column if exists is_completed;

-- ----------------------------------------------------------------------------
-- pod_contributions
-- ----------------------------------------------------------------------------
alter table public.pod_contributions alter column amount type numeric;
alter table public.pod_contributions drop constraint if exists pod_contributions_amount_check;
alter table public.pod_contributions
  add constraint pod_contributions_amount_check check (amount > (0)::numeric);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pod_contributions' and column_name = 'contributed_at') then
    alter table public.pod_contributions rename column contributed_at to created_at;
  end if;
end $$;
alter table public.pod_contributions alter column created_at set not null;
alter table public.pod_contributions add column if not exists note text;

-- ----------------------------------------------------------------------------
-- portfolio_snapshots — genuine design change, not a rename: live is one
-- row per broker connection per snapshot, the migrations' shape is one
-- aggregated row per user per day broken down by asset class. Safe to
-- restructure with 0 existing rows; would need real data-migration logic
-- (summing broker_connection_id rows into one per user/day) otherwise.
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'portfolio_snapshots' and column_name = 'total_value_usd') then
    alter table public.portfolio_snapshots rename column total_value_usd to total_net_worth;
  end if;
end $$;
alter table public.portfolio_snapshots alter column total_net_worth type numeric;
alter table public.portfolio_snapshots alter column total_net_worth set not null;

alter table public.portfolio_snapshots add column if not exists crypto_value numeric default 0 not null;
alter table public.portfolio_snapshots add column if not exists forex_value numeric default 0 not null;
alter table public.portfolio_snapshots add column if not exists manual_assets_value numeric default 0 not null;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'portfolio_snapshots' and column_name = 'snapshot_at') then
    alter table public.portfolio_snapshots rename column snapshot_at to snapshot_date;
  end if;
end $$;
alter table public.portfolio_snapshots alter column snapshot_date type date using snapshot_date::date;
-- The USING cast above carries the old DEFAULT now() (timestamptz)
-- forward as an implicit (now())::date, which the target schema doesn't
-- specify — drop it explicitly rather than leave an undocumented default.
alter table public.portfolio_snapshots alter column snapshot_date drop default;
alter table public.portfolio_snapshots alter column snapshot_date set not null;

alter table public.portfolio_snapshots add column if not exists created_at timestamptz default now() not null;
alter table public.portfolio_snapshots drop column if exists broker_connection_id;
