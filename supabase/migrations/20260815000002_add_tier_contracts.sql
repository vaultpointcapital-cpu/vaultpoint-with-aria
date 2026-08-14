-- ============================================================================
-- Tier Contract — What Each Tier Promises (v1)
-- ============================================================================
-- Source of truth for what free/pro/elite/managed subscribers are promised,
-- versioned so changing what Pro includes later never retroactively changes
-- what an existing subscriber was told at signup/renewal. Feeds a
-- `value_to_price_ratio` metric the Value Ledger system computes
-- (value_score / tier price) — see 20260815000000_add_value_ledger.sql,
-- which landed alongside this migration and DOES now exist, correcting
-- this comment's earlier assumption that it didn't. That system is
-- event-sourced (value_ledger_events, free-text event_name — deliberately
-- unbounded, per its own comment, "event types will grow over time...a
-- CHECK constraint would need a migration per new type") plus a nightly
-- rollup table (value_ledger_rollups) of fixed, hardcoded numeric columns
-- (alerts_acted_on_30d, aria_recommendation_count_30d, etc.) — NOT a
-- lookup/catalog table of named "metric definitions" with stable ids. There
-- is still no enumerable table tier_commitments.metric_key could reference
-- via a real FK. Per that gap:
--   - tier_commitments.metric_key is FREE TEXT, not a real FK, and NOT
--     validated against anything at data-entry time. The spec's own build
--     requirement ("reject at data-entry time if the metric doesn't
--     exist") still cannot be built as a real existence check — there's no
--     catalog to check against, only an open-ended event stream and a
--     fixed rollup schema. This is a deliberate, documented deferral, not
--     a silent drop. Do NOT invent a fake metrics catalog here — if/when
--     the Value Ledger PRD adds one, wire this up then.
--   - The `measurable` boolean IS enforced at the DB level (see the CHECK
--     constraint below): a commitment can't be marked measurable without
--     *some* metric_key text, even though that text's real-world existence
--     is unverified. Partial enforcement, not none.
--   - Several seed metric_key values below (connected_account_count,
--     active_pod_count, aria_interaction_log) describe concepts the Value
--     Ledger's rollup table also tracks under different column names
--     (e.g. aria_recommendation_count_30d) — deliberately NOT renamed to
--     match, since tier_commitments.metric_key is this table's own
--     vocabulary describing what's promised, not a literal pointer into
--     value_ledger_rollups' column list; forcing 1:1 naming now would
--     couple this table's schema to that one's internal column names
--     before any real integration exists.
--
-- tier_name is a NEW, STANDALONE vocabulary — deliberately NOT the same as
-- SubscriptionTier ('free'|'pro'|'elite', src/types/database.ts) and NOT
-- the same as managed_accounts.tier ('bronze'|'silver'|'gold', a
-- risk/profit-split tier WITHIN a Managed Account, itself flagged as a
-- placeholder set in 20260718000004's header comment). A user's
-- subscription_tier and their Managed Account enrollment are orthogonal —
-- an Elite subscriber can also hold a Managed Account, and a Free-tier user
-- can hold one too. tier_name = 'managed' represents "this client has an
-- active Managed Account", read off managed_accounts.tier_contract_id
-- below, never off users.subscription_tier or managed_accounts.tier.
--
-- Versioning invariant: an active tier_contract row is NEVER updated in
-- place. create_tier_contract_version() (below) is the only sanctioned way
-- to add a new version — it locks the current active row for the tier_name,
-- flips it to 'superseded', and inserts the new one as 'active', in one
-- transaction. The partial unique index below additionally guarantees at
-- the DB level that at most one row per tier_name is ever 'active', so this
-- invariant holds even against a bug in the RPC or a manual Table Editor
-- edit.
--
-- Managed Accounts commitment_description copy (seeded below) is drafted
-- from this codebase's own existing docs (docs/managed-accounts/*.md — all
-- engineering docs, not legal-reviewed copy) and the spec's own draft
-- language. NOT reviewed against actual SEC Nigeria managed-account
-- language. compliance_signoff_at stays NULL for this row until Legal signs
-- off — the pricing page (src/lib/tier-contracts/get-active-contract.ts,
-- src/app/pricing/page.tsx) must not render Managed Accounts commitments
-- publicly while its contract's compliance_signoff_at is null. This is an
-- app-layer check, not a DB constraint, so it doesn't block the existing
-- (already-live) Managed Accounts onboarding/funding flow — only the new
-- public marketing copy this spec adds.
--
-- price_ngn below is corrected against the ACTUAL configured billing amount
-- (src/lib/billing/flutterwave.ts's TIER_AMOUNT_NGN: pro=20000, elite=55000)
-- rather than the spec draft's stated elite=65000 — seeding a disagreeing
-- number here would be exactly the kind of price/copy drift this spec
-- exists to prevent. price_usd is left null for every tier: no flat USD
-- price is configured anywhere in this codebase today (Stripe prices are
-- env-var-driven Price IDs) — fill in once one exists.
-- ============================================================================

create table public.tier_contracts (
  id uuid primary key default gen_random_uuid(),
  tier_name text not null check (tier_name in ('free', 'pro', 'elite', 'managed')),
  version int not null,
  effective_date date not null,
  price_ngn int,
  price_usd int,
  status text not null default 'active' check (status in ('active', 'superseded')),
  created_by text,
  change_reason text,
  -- Null until Legal has reviewed this version's commitment copy against
  -- actual regulatory language. Only meaningfully gates tier_name='managed'
  -- in v1 — see header comment.
  compliance_signoff_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tier_name, version)
);

-- The hard DB-level guarantee behind "never edit an active row in place":
-- at most one 'active' row per tier_name, always, regardless of what wrote it.
create unique index tier_contracts_one_active_per_tier
  on public.tier_contracts (tier_name)
  where status = 'active';

create index tier_contracts_tier_status_idx on public.tier_contracts (tier_name, status);

comment on table public.tier_contracts is
  'Versioned source of truth for what each pricing tier promises. Never updated in place once active — see create_tier_contract_version(). tier_name is its own vocabulary, deliberately not SubscriptionTier or managed_accounts.tier (see header comment).';

create table public.tier_commitments (
  id uuid primary key default gen_random_uuid(),
  tier_contract_id uuid not null references public.tier_contracts(id),
  commitment_key text not null,
  commitment_description text not null,
  commitment_type text not null check (commitment_type in ('feature_access', 'outcome', 'sla', 'limit')),
  measurable boolean not null default false,
  -- Free text, NOT FK-enforced — see header comment: no Value Ledger
  -- metric registry exists anywhere in this codebase yet to validate
  -- against. Deferred, not dropped.
  metric_key text,
  created_at timestamptz not null default now(),
  -- Partial enforcement of "no promising something unmeasurable": a
  -- measurable commitment must at least carry SOME metric_key text, even
  -- though its real-world existence can't be verified yet.
  constraint tier_commitments_measurable_requires_metric_key
    check (not measurable or metric_key is not null)
);

create index tier_commitments_contract_idx on public.tier_commitments (tier_contract_id);

comment on table public.tier_commitments is
  'Per-tier-contract-version commitments. metric_key is free text pending a real Value Ledger metric registry (does not exist in this codebase yet) — see tier_contracts header comment.';

alter table public.tier_contracts enable row level security;
alter table public.tier_commitments enable row level security;

-- Public (including anon, for the pricing page): read active contracts
-- only. No client role — including admin — has an insert/update policy;
-- all writes go through create_tier_contract_version() called via the
-- admin route's service-role client, same "app-layer isAdmin() check +
-- service-role bypass, no is_admin-in-RLS-for-writes" shape already used
-- for watchlist_symbols/candidate_setups (20260814000000) and
-- signal_scores (20260814000001). No user_id column exists on either
-- table — these are shared tier *definitions*, not per-user data, so
-- "own contract" isn't a meaningful read-scope here (see
-- subscriptions.tier_contract_id / managed_accounts.tier_contract_id for
-- the actual per-subscriber snapshot).
create policy "Anyone can view active tier contracts"
  on public.tier_contracts for select
  using (status = 'active');

create policy "Anyone can view commitments on active tier contracts"
  on public.tier_commitments for select
  using (exists (
    select 1 from public.tier_contracts
    where tier_contracts.id = tier_commitments.tier_contract_id
    and tier_contracts.status = 'active'
  ));

-- Snapshot columns: which tier_contract version was active when this
-- subscriber signed up or last renewed — never "whatever's active today".
-- Nullable: a subscriptions/managed_accounts row written before this
-- migration, or one created before seed data exists, has none — the app
-- must treat null as "unknown, not measurable yet", never fail on it.
alter table public.subscriptions
  add column tier_contract_id uuid references public.tier_contracts(id);

alter table public.managed_accounts
  add column tier_contract_id uuid references public.tier_contracts(id);

comment on column public.subscriptions.tier_contract_id is
  'The tier_contracts row active at signup or last renewal — stamped by snapshotTierContractOnRenewal() (src/lib/tier-contracts/snapshot.ts), never by a cancel/past_due webhook branch. This is what value_to_price_ratio must read, not the currently-active contract.';
comment on column public.managed_accounts.tier_contract_id is
  'The active tier_name=''managed'' tier_contracts row, stamped once when status transitions to ''active'' in POST /api/managed-accounts/:id/fund (the real "this account went live" moment — see 20260718000004_add_managed_accounts.sql; this is NOT gated through subscriptions).';

-- ============================================================================
-- create_tier_contract_version: the ONLY sanctioned write path for a new
-- version. Row-locks the current active row for tier_name (if any),
-- computes the next version number across ALL versions (active +
-- superseded, so version numbers never get reused after a supersede),
-- inserts the new row as 'active', flips the prior active row (if any) to
-- 'superseded', inserts its commitments, and returns the new id/version —
-- all in one transaction. Mirrors wallet_apply_transaction's shape
-- (20260802000000_add_wallet.sql): row-locked, single function, explicit
-- errcode on the one real failure mode this function itself checks
-- (missing change_reason) — the measurable/metric_key rule is left to the
-- table's own CHECK constraint, which fires just as reliably from inside
-- this function's inserts.
-- ============================================================================
create or replace function public.create_tier_contract_version(
  p_tier_name text,
  p_price_ngn int,
  p_price_usd int,
  p_effective_date date,
  p_created_by text,
  p_change_reason text,
  p_commitments jsonb  -- array of {commitment_key, commitment_description, commitment_type, measurable, metric_key}
)
returns table (tier_contract_id uuid, version int)
language plpgsql
security invoker
as $$
declare
  v_prior_id uuid;
  v_next_version int;
  v_new_id uuid;
  v_commitment jsonb;
begin
  if p_change_reason is null or length(trim(p_change_reason)) = 0 then
    raise exception 'change_reason is required' using errcode = 'P0001';
  end if;

  select id into v_prior_id
  from public.tier_contracts
  where tier_name = p_tier_name and status = 'active'
  for update;

  select coalesce(max(version), 0) + 1 into v_next_version
  from public.tier_contracts
  where tier_name = p_tier_name;

  insert into public.tier_contracts
    (tier_name, version, effective_date, price_ngn, price_usd, status, created_by, change_reason)
  values
    (p_tier_name, v_next_version, p_effective_date, p_price_ngn, p_price_usd, 'active', p_created_by, p_change_reason)
  returning id into v_new_id;

  if v_prior_id is not null then
    update public.tier_contracts set status = 'superseded' where id = v_prior_id;
  end if;

  for v_commitment in select * from jsonb_array_elements(p_commitments)
  loop
    insert into public.tier_commitments
      (tier_contract_id, commitment_key, commitment_description, commitment_type, measurable, metric_key)
    values
      (v_new_id,
       v_commitment->>'commitment_key',
       v_commitment->>'commitment_description',
       v_commitment->>'commitment_type',
       (v_commitment->>'measurable')::boolean,
       v_commitment->>'metric_key');
  end loop;

  return query select v_new_id, v_next_version;
end;
$$;

comment on function public.create_tier_contract_version is
  'The only sanctioned way to add a new tier_contract version. Never call UPDATE on an active tier_contracts row directly. Called from POST /api/admin/tier-contracts via the service-role client, after an app-layer isAdmin() check — this function does not itself check admin status.';

-- Seed: v1 draft tier definitions, per the spec's own "fill in before
-- build, this is a starting draft" instruction — seeded as given, no
-- invented extra commitments. Elite/Pro price_ngn corrected against
-- TIER_AMOUNT_NGN (see header comment); Managed Accounts price_ngn/usd
-- left null (profit-split product, no flat subscription price) and
-- compliance_signoff_at left null (NOT reviewed against SEC Nigeria
-- language — see header comment).
select public.create_tier_contract_version(
  'free', 0, 0, date '2026-08-15', 'seed_migration_20260815000000',
  'Initial v1 tier contract seed.',
  '[
    {"commitment_key": "connected_trading_accounts", "commitment_description": "Connect up to 1 trading account (Bybit or MT5).", "commitment_type": "feature_access", "measurable": true, "metric_key": "connected_account_count"},
    {"commitment_key": "net_worth_dashboard", "commitment_description": "Basic Net Worth Dashboard.", "commitment_type": "feature_access", "measurable": false, "metric_key": null},
    {"commitment_key": "savings_pods_limit", "commitment_description": "1 active Savings Pod.", "commitment_type": "limit", "measurable": true, "metric_key": "active_pod_count"},
    {"commitment_key": "price_alerts_only", "commitment_description": "Price alerts only — no P&L threshold alerts.", "commitment_type": "feature_access", "measurable": true, "metric_key": "alert_type_usage"}
  ]'::jsonb
);

select public.create_tier_contract_version(
  'pro', 20000, null, date '2026-08-15', 'seed_migration_20260815000000',
  'Initial v1 tier contract seed. price_ngn matches TIER_AMOUNT_NGN.pro (src/lib/billing/flutterwave.ts), not the spec draft''s unconfirmed figure.',
  '[
    {"commitment_key": "connected_trading_accounts", "commitment_description": "Connect up to 5 trading accounts across Bybit, MT5, and Hantec.", "commitment_type": "feature_access", "measurable": true, "metric_key": "connected_account_count"},
    {"commitment_key": "savings_pods_unlimited", "commitment_description": "Unlimited Savings Pods.", "commitment_type": "feature_access", "measurable": true, "metric_key": "active_pod_count"},
    {"commitment_key": "pnl_and_portfolio_alerts", "commitment_description": "P&L threshold alerts and portfolio percentage-change alerts.", "commitment_type": "feature_access", "measurable": true, "metric_key": "alert_type_usage"},
    {"commitment_key": "aria_basic_advisory", "commitment_description": "Aria basic advisory — read-only insights, no auto-execution.", "commitment_type": "feature_access", "measurable": true, "metric_key": "aria_interaction_log"},
    {"commitment_key": "never_miss_margin_call", "commitment_description": "Never miss a margin call across your connected accounts.", "commitment_type": "outcome", "measurable": true, "metric_key": "alert_acted_on_margin_call"}
  ]'::jsonb
);

select public.create_tier_contract_version(
  'elite', 55000, null, date '2026-08-15', 'seed_migration_20260815000000',
  'Initial v1 tier contract seed. Self-contained superset of Pro (each tier''s commitment list is independent, not inherited). price_ngn matches TIER_AMOUNT_NGN.elite, corrected from the spec draft''s unconfirmed 65000.',
  '[
    {"commitment_key": "connected_trading_accounts", "commitment_description": "Unlimited connected trading accounts.", "commitment_type": "feature_access", "measurable": true, "metric_key": "connected_account_count"},
    {"commitment_key": "savings_pods_unlimited", "commitment_description": "Unlimited Savings Pods.", "commitment_type": "feature_access", "measurable": true, "metric_key": "active_pod_count"},
    {"commitment_key": "pnl_and_portfolio_alerts", "commitment_description": "P&L threshold alerts and portfolio percentage-change alerts.", "commitment_type": "feature_access", "measurable": true, "metric_key": "alert_type_usage"},
    {"commitment_key": "aria_full_advisory_pantheon", "commitment_description": "Aria full advisory with Pantheon subagent insights (Argus, Plutus, Hermes, Mnemosyne).", "commitment_type": "feature_access", "measurable": true, "metric_key": "aria_interaction_log"},
    {"commitment_key": "priority_alert_delivery", "commitment_description": "Priority alert delivery — push notification with SMS fallback.", "commitment_type": "sla", "measurable": true, "metric_key": "alert_delivery_latency"},
    {"commitment_key": "cross_market_conditional_alerts", "commitment_description": "Cross-market conditional alerts (e.g. \"if BTC drops X% AND my forex margin drops below Y\").", "commitment_type": "outcome", "measurable": true, "metric_key": "conditional_alert_fire_log"},
    {"commitment_key": "never_miss_margin_call", "commitment_description": "Never miss a margin call across your connected accounts.", "commitment_type": "outcome", "measurable": true, "metric_key": "alert_acted_on_margin_call"}
  ]'::jsonb
);

-- NOT compliance-approved — compliance_signoff_at stays null via a
-- separate UPDATE below (create_tier_contract_version doesn't accept it as
-- a param on purpose, so it can never be set at seed/creation time — only
-- a deliberate follow-up action can flip it). Copy drawn from this
-- codebase's own docs/managed-accounts/*.md, not confirmed against actual
-- SEC Nigeria language. Do not surface these commitment_description values
-- in any public/marketing context until compliance_signoff_at is set.
select public.create_tier_contract_version(
  'managed', null, null, date '2026-08-15', 'seed_migration_20260815000000',
  'Initial v1 tier contract seed. NOT reviewed by Legal/Compliance against SEC Nigeria managed-account language — see this migration''s header comment and tier_contracts.compliance_signoff_at.',
  '[
    {"commitment_key": "fee_disclosure", "commitment_description": "Fully disclosed fee structure, itemized per charge.", "commitment_type": "outcome", "measurable": true, "metric_key": "fee_attribution_clarity_score"},
    {"commitment_key": "net_return_reporting", "commitment_description": "Net return reporting, time-windowed and updated in real time.", "commitment_type": "outcome", "measurable": true, "metric_key": "managed_account_net_return"},
    {"commitment_key": "trader_qualification_matching", "commitment_description": "Trader qualification and risk-tier matching before enrollment.", "commitment_type": "sla", "measurable": true, "metric_key": "onboarding_completion_log"},
    {"commitment_key": "human_escalation_path", "commitment_description": "A human escalation path for disputes.", "commitment_type": "sla", "measurable": true, "metric_key": "escalation_policy_log"}
  ]'::jsonb
);
-- human_escalation_path's metric_key ('escalation_policy_log') is another
-- placeholder in the same spirit as the Value Ledger gap: no
-- escalation-policy spec/doc exists anywhere in this repo (checked
-- docs/managed-accounts/*.md) to point this at. Same free-text, deferred
-- treatment.

-- down
-- drop function public.create_tier_contract_version;
-- alter table public.managed_accounts drop column tier_contract_id;
-- alter table public.subscriptions drop column tier_contract_id;
-- drop table public.tier_commitments;
-- drop table public.tier_contracts;
