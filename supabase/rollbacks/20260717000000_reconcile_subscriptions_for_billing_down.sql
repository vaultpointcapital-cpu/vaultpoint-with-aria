-- ============================================================================
-- DOWN migration for 20260717000000_reconcile_subscriptions_for_billing.sql
-- ============================================================================
-- Deliberately NOT placed in supabase/migrations/ — the Supabase CLI applies
-- every .sql file in that directory forward, in filename order. Putting a
-- "down" file there would make `supabase db push` try to run it as a
-- forward migration too, undoing the reconciliation immediately after
-- applying it. Run this file manually (Supabase Dashboard SQL editor or
-- psql) only if you need to roll back the up migration.
--
-- Reverses in the opposite order the up migration applied changes.
-- ============================================================================

alter table public.billing_webhook_events disable row level security;
drop table if exists public.billing_webhook_events;

drop index if exists public.idx_subscriptions_user;

alter table public.subscriptions drop column if exists updated_at;
alter table public.subscriptions drop column if exists provider_customer_id;

alter table public.subscriptions drop constraint if exists subscriptions_status_check;

alter table public.subscriptions drop constraint if exists subscriptions_payment_provider_check;
alter table public.subscriptions rename column payment_provider to provider;

alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions rename column tier to plan;
