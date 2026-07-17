-- ============================================================================
-- VaultPoint — Reconcile subscriptions for Stripe/Paystack billing
-- ============================================================================
-- Written as ALTER, not CREATE TABLE. public.subscriptions already exists —
-- both in the live database (columns: plan, provider, no
-- provider_customer_id, no updated_at, no CHECK constraints) and in this
-- repo's 20260617000000_initial_schema.sql (columns: tier, payment_provider,
-- still no provider_customer_id). This migration takes live's actual
-- current shape as ground truth and reconciles it forward to what the
-- billing integration needs, rather than introducing a third definition.
--
-- Renames are used (not add-new-drop-old) to preserve existing data.
--
-- Idempotent by design: RENAME COLUMN is guarded (skipped if the target
-- name already exists — e.g. on a fresh project built straight from the
-- migration stack, which never had `plan`/`provider` to begin with),
-- columns use ADD COLUMN IF NOT EXISTS, and constraints are dropped and
-- re-added rather than assumed absent. This lets the same file run
-- safely against live's current (old) shape, an already-reconciled
-- database, or a brand-new project — required for the CI migration
-- dry-run job (applies the full stack fresh on every PR) to not break
-- the first time this merges.
--
-- CHECK constraints below are added as NOT VALID deliberately: this
-- environment has no read access to live's actual row data (the DB
-- reconciliation work this migration follows was schema-only, read-only
-- access to live), so it's unverified whether every existing row already
-- satisfies these constraints. NOT VALID lets the ALTER succeed and
-- enforces the constraint for all future writes immediately, without
-- failing outright if some existing row doesn't conform. Before treating
-- this as fully reconciled, run:
--   ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_tier_check;
--   ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_payment_provider_check;
--   ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_status_check;
-- once you've confirmed existing rows are clean, or fix any rows that fail.
-- (A live row-count check during this work found subscriptions has 0 rows
-- today, so in practice there's nothing to violate — but the NOT VALID
-- hedge costs nothing and this migration may run again later against a
-- live with real data.)
-- ============================================================================

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'plan') then
    alter table public.subscriptions rename column plan to tier;
  end if;
end $$;

alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions
  add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'elite')) not valid;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'provider') then
    alter table public.subscriptions rename column provider to payment_provider;
  end if;
end $$;

alter table public.subscriptions drop constraint if exists subscriptions_payment_provider_check;
alter table public.subscriptions
  add constraint subscriptions_payment_provider_check
  check (payment_provider in ('stripe', 'paystack')) not valid;

alter table public.subscriptions drop constraint if exists subscriptions_status_check;
alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active', 'past_due', 'cancelled', 'trialing')) not valid;

-- New columns the billing integration needs.
alter table public.subscriptions add column if not exists provider_customer_id text;
alter table public.subscriptions add column if not exists updated_at timestamptz default now();

comment on column public.subscriptions.provider_customer_id is
  'Stripe customer id or Paystack customer code — set on first successful checkout.session.completed / charge.success, used to match later webhook events for renewals/cancellations.';

create index if not exists idx_subscriptions_user on public.subscriptions(user_id);

-- public.users.country already exists (added in 20260617000000_initial_schema.sql)
-- as `country text` — no column addition needed for provider routing.

-- ----------------------------------------------------------------------------
-- billing_webhook_events — idempotency + replay/debug audit trail.
--
-- Not reusing public.autonomous_action_log: that table requires a NOT NULL
-- authorization_id FK into execution_authorizations and constrains
-- action_type to trade_execute/withdrawal/deposit — a different domain
-- (autonomous trade actions), not a structural fit for generic payment
-- provider webhook events.
--
-- Deliberately does NOT store the raw webhook payload — per spec, webhook
-- bodies can carry card data/customer PII. `metadata` holds only the
-- non-sensitive fields the handlers actually need to replay/debug
-- (event type, subscription id, status, user id) — never card numbers,
-- emails, or full provider payloads.
-- ----------------------------------------------------------------------------
create table if not exists public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'paystack')),
  event_id text not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now(),
  constraint billing_webhook_events_provider_event_unique unique (provider, event_id)
);

comment on table public.billing_webhook_events is
  'Idempotency + audit log for Stripe/Paystack webhook events. The (provider, event_id) unique constraint is the hard backstop against double-processing a retried event. Never stores full raw payloads or PII/card data — see column comments.';
comment on column public.billing_webhook_events.metadata is
  'Non-sensitive event metadata only (subscription id, status, user id) — never the raw webhook body, which may contain card data or PII.';

alter table public.billing_webhook_events enable row level security;
-- No client-facing policies: only ever read/written by webhook route
-- handlers using the service-role client, which bypasses RLS. Enabling
-- RLS with zero policies means it's also inaccessible to the anon/
-- authenticated roles by default, which is the intended posture here.
