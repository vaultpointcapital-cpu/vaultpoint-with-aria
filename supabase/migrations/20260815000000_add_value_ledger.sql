-- ============================================================================
-- Value Ledger — Foundation (Phase 1)
-- ============================================================================
-- PRD: "Value Realization & Business Health Monitoring Infrastructure".
-- Event-sourced, not just a metrics table: raw immutable events
-- (value_ledger_events) + a nightly computed rollup (value_ledger_rollups,
-- a plain upserted table, not a materialized view — no materialized view
-- exists anywhere in this codebase yet; portfolio_snapshots is the actual
-- existing "nightly rollup" precedent this follows instead).
--
-- Isolated module, same "no shared blast radius" convention as the wallet
-- and KYC-tiering migrations — nothing here is read or written by Pods,
-- Alerts, Billing, or Aria's core paths; those services only ever call
-- value_ledger_apply_event() as a one-way, best-effort side effect.
-- ============================================================================

create table public.value_ledger_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- Generic event_name/properties (not a fixed enum) — event types will
  -- grow over time (pod_goal_hit, position_closed, tier_changed,
  -- payment_failed, wallet_deposit, kyc_tier_upgraded, ...) and a CHECK
  -- constraint would need a migration per new type. Same shape as
  -- usage_events, combined with wallet_transactions' idempotency-key +
  -- atomic-RPC-writer pattern since multiple server-side triggers write
  -- here and need replay-safety.
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  source text not null default 'app',
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.value_ledger_events is
  'Append-only, immutable (PRD non-negotiable §8.2 — no update/delete path exists anywhere). Only ever written via value_ledger_apply_event(). Rolled up nightly into value_ledger_rollups; never read directly by end-user-facing routes.';

create index value_ledger_events_user_created_idx on public.value_ledger_events (user_id, created_at desc);
create index value_ledger_events_name_created_idx on public.value_ledger_events (event_name, created_at desc);

alter table public.value_ledger_events enable row level security;
-- Zero client policies (mirrors kyc_webhook_events) — internal audit/
-- analytics infra, never directly client-readable. Only the RPC writer
-- and the nightly rollup job (both service-role) ever touch this table.

-- ============================================================================
-- value_ledger_apply_event — idempotent insert-only writer, mirrors
-- wallet_apply_transaction's shape (security invoker, on-conflict-do-
-- nothing on the idempotency key, only ever called from a service-role
-- context since this table has no client insert policy).
-- ============================================================================
create or replace function public.value_ledger_apply_event(
  p_user_id uuid,
  p_event_name text,
  p_idempotency_key text,
  p_properties jsonb default '{}'::jsonb,
  p_source text default 'app'
)
returns table (event_id uuid, inserted boolean)
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  insert into public.value_ledger_events (user_id, event_name, properties, source, idempotency_key)
  values (p_user_id, p_event_name, p_properties, p_source, p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true;
  else
    select id into v_id from public.value_ledger_events where idempotency_key = p_idempotency_key;
    return query select v_id, false;
  end if;
end;
$$;

comment on function public.value_ledger_apply_event is
  'Idempotent insert-only writer for value_ledger_events, mirrors wallet_apply_transaction. Raw events are immutable — no update/delete path exists anywhere.';

-- ============================================================================
-- value_ledger_rollups — one row per (user, day), upserted nightly by
-- services/broker-sync/app/value_ledger_rollup.py. Derived/recomputable,
-- not a raw-event table, so overwrite-on-recompute is correct here (unlike
-- value_ledger_events).
-- ============================================================================
create table public.value_ledger_rollups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rollup_date date not null,
  subscription_tier text not null,

  -- raw component inputs (pre-normalization; kept for dashboard drill-down/debugging)
  pod_goal_hits_30d integer not null default 0,
  pod_pace_delta_pct numeric,               -- null: no active pod has a deadline to schedule against
  alerts_fired_30d integer not null default 0,
  alerts_acted_on_30d integer not null default 0,
  alert_pnl_saved_30d numeric,              -- null: no alerts fired
  aria_recommendation_winrate_30d numeric,  -- null: no Aria-attributed closes in window
  aria_recommendation_count_30d integer not null default 0,
  time_to_first_value_days integer,         -- null: not yet reached
  feature_adoption_rate numeric not null default 0,  -- 0..1, always computable

  -- composite scores (PRD §5/§6)
  value_score numeric not null default 0,        -- 0..100
  tier_price_normalized numeric,                 -- null for free tier
  value_to_price_ratio numeric,                  -- null for free tier
  churn_risk_score numeric not null default 0,   -- 0..100
  churn_risk_level text not null default 'low' check (churn_risk_level in ('low', 'medium', 'high')),
  churn_risk_reasons text[] not null default '{}',
  upsell_candidate boolean not null default false,

  -- §3A managed-account signals — informational only, dashboard-only.
  -- Not part of value_score/churn_risk_score (§5's formula doesn't
  -- include them) and not surfaced to the end user (Phase 3's in-app
  -- net-return reporting is deferred).
  managed_account_net_return_30d numeric,
  fee_to_return_ratio_30d numeric,

  created_at timestamptz not null default now(),
  unique (user_id, rollup_date)
);

comment on table public.value_ledger_rollups is
  'Nightly per-user rollup, plain upserted table (not a materialized view — see migration header). Written only by services/broker-sync/app/value_ledger_rollup.py.';

create index value_ledger_rollups_date_idx on public.value_ledger_rollups (rollup_date desc);
create index value_ledger_rollups_user_date_idx on public.value_ledger_rollups (user_id, rollup_date desc);

alter table public.value_ledger_rollups enable row level security;
-- Service-role only for this pass — no select-own policy. churn_risk_score
-- is an internal operational signal with no current UI consumer; keeping
-- it invisible to the user by default is the safer starting posture.
-- Adding a select-own policy later for a "your value" widget is a
-- one-line, zero-migration-risk addition whenever that's actually built.
