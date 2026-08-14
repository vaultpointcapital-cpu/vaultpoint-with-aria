-- ============================================================================
-- DOWN migration for 20260717000001_reconcile_remaining_tables_with_live.sql
-- ============================================================================
-- Same rule as the other rollback file: NOT in supabase/migrations/, run
-- manually only. Reverses in the opposite order the up migration applied.
--
-- portfolio_snapshots.broker_connection_id and savings_pods.is_completed
-- were DROPPED (not just renamed) in the up migration — this rollback
-- re-adds them empty. If real data existed when the up migration ran,
-- that data is not recoverable from this rollback; restore from the
-- pre-migration pg_dump backup instead (see RUNBOOK-DB-RECONCILE.md).
-- ============================================================================

-- portfolio_snapshots
alter table public.portfolio_snapshots add column broker_connection_id uuid;
alter table public.portfolio_snapshots drop column if exists created_at;
alter table public.portfolio_snapshots alter column snapshot_date type timestamptz using snapshot_date::timestamptz;
alter table public.portfolio_snapshots alter column snapshot_date set default now();
alter table public.portfolio_snapshots rename column snapshot_date to snapshot_at;
alter table public.portfolio_snapshots drop column if exists manual_assets_value;
alter table public.portfolio_snapshots drop column if exists forex_value;
alter table public.portfolio_snapshots drop column if exists crypto_value;
alter table public.portfolio_snapshots alter column total_net_worth drop not null;
alter table public.portfolio_snapshots rename column total_net_worth to total_value_usd;

-- pod_contributions
alter table public.pod_contributions drop column if exists note;
alter table public.pod_contributions alter column created_at drop not null;
alter table public.pod_contributions rename column created_at to contributed_at;
alter table public.pod_contributions drop constraint if exists pod_contributions_amount_check;

-- savings_pods
alter table public.savings_pods add column is_completed boolean default false;
alter table public.savings_pods alter column created_at drop not null;
alter table public.savings_pods drop constraint if exists savings_pods_status_check;
alter table public.savings_pods drop column if exists status;
alter table public.savings_pods drop column if exists updated_at;
alter table public.savings_pods drop column if exists color;
alter table public.savings_pods rename column deadline to target_date;
alter table public.savings_pods alter column currency drop not null;
alter table public.savings_pods drop constraint if exists savings_pods_current_amount_check;
alter table public.savings_pods alter column current_amount drop not null;
alter table public.savings_pods drop constraint if exists savings_pods_target_amount_check;

-- manual_assets
alter table public.manual_assets alter column updated_at drop not null;
alter table public.manual_assets drop column if exists created_at;
alter table public.manual_assets drop column if exists currency;
alter table public.manual_assets drop constraint if exists manual_assets_asset_type_check;
alter table public.manual_assets drop column if exists asset_type;
alter table public.manual_assets rename column value to value_usd;
alter table public.manual_assets rename column label to name;

-- broker_connections
alter table public.broker_connections drop constraint if exists broker_connections_non_metatrader_requires_api_credentials;
alter table public.broker_connections drop constraint if exists broker_connections_metatrader_requires_mt_credentials;
alter table public.broker_connections drop column if exists metaapi_region;
alter table public.broker_connections drop column if exists metaapi_account_id;
alter table public.broker_connections drop column if exists mt_password_iv;
alter table public.broker_connections drop column if exists encrypted_mt_password;
alter table public.broker_connections drop constraint if exists broker_connections_mt_platform_check;
alter table public.broker_connections drop column if exists mt_platform;
alter table public.broker_connections drop column if exists mt_server;
alter table public.broker_connections drop column if exists mt_login;
alter table public.broker_connections drop constraint if exists broker_connections_kucoin_requires_passphrase;
alter table public.broker_connections drop column if exists api_passphrase_iv;
alter table public.broker_connections drop column if exists encrypted_api_passphrase;
alter table public.broker_connections drop column if exists updated_at;
alter table public.broker_connections drop column if exists last_error;
alter table public.broker_connections drop constraint if exists broker_connections_sync_status_check;
alter table public.broker_connections drop column if exists sync_status;
alter table public.broker_connections drop column if exists is_read_only;
alter table public.broker_connections drop column if exists api_secret_iv;
alter table public.broker_connections alter column api_key_iv set not null;
alter table public.broker_connections rename column api_key_iv to encryption_iv;
alter table public.broker_connections alter column encrypted_api_secret set not null;
alter table public.broker_connections alter column encrypted_api_key set not null;
alter table public.broker_connections alter column label drop not null;
alter table public.broker_connections drop constraint if exists broker_connections_broker_check;
alter table public.broker_connections rename column broker to broker_name;

-- alert_history
alter table public.alert_history drop column if exists delivered_via;
alter table public.alert_history alter column created_at drop not null;
alter table public.alert_history alter column message drop not null;
alter table public.alert_history alter column triggered_value drop not null;
alter table public.alert_history rename column created_at to triggered_at;

-- alerts
alter table public.alerts drop constraint if exists alerts_condition_type_check;
alter table public.alerts alter column created_at drop not null;
alter table public.alerts alter column is_active drop not null;
alter table public.alerts drop constraint if exists alerts_operator_check;
alter table public.alerts drop column if exists operator;
alter table public.alerts rename column threshold to threshold_value;

-- positions
alter table public.positions drop constraint if exists positions_side_check;
alter table public.positions drop column if exists margin_used;
alter table public.positions drop column if exists unrealized_pnl_pct;
alter table public.positions drop column if exists leverage;
alter table public.positions alter column synced_at drop not null;
alter table public.positions alter column synced_at drop default;
alter table public.positions rename column synced_at to updated_at;
alter table public.positions alter column entry_price drop not null;
alter table public.positions alter column mark_price type numeric(18,6);
alter table public.positions rename column mark_price to current_price;
alter table public.positions alter column size drop not null;
alter table public.positions rename column size to quantity;

-- users
alter table public.users drop column if exists academy_student;
alter table public.users drop constraint if exists users_subscription_tier_check;
alter table public.users drop column if exists subscription_tier;
alter table public.users alter column updated_at drop not null;
alter table public.users alter column created_at drop not null;
alter table public.users alter column onboarding_completed drop not null;
alter table public.users rename column country_code to country;
