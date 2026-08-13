-- ============================================================================
-- Portfolio Risk Aggregator
-- ============================================================================
-- Per vaultpoint-quant-trading-desk-spec.pdf §4 — that PRD's own Build
-- Sequencing lists this as item #1, "blocks everything else in §4." This
-- migration is scoped to ONLY this piece: aggregate currency/asset-cluster
-- exposure per book + a book-level monthly drawdown circuit breaker. It
-- does NOT build Track A prop capital provisioning, a backtest engine, or
-- Track B promotion — those are separate, later Build Sequencing items,
-- and several of them are explicitly flagged in the PRD's own §8 as
-- needing lawyer/compliance review before going live with real capital.
-- This migration has no capital-deployment mechanics of its own, so it
-- doesn't trigger that gate — it's risk-LIMITING infrastructure sitting
-- in front of an execution path (decision_gate/execution_adapter.py's
-- NullExecutionAdapter) that doesn't place real trades yet anyway.
--
-- Correlation methodology: NOT a live statistical price-correlation
-- matrix (needs historical-data infra this codebase doesn't have, a much
-- larger undertaking). Instead: currency/asset-cluster NET EXPOSURE — an
-- FX position is decomposed into its two currency legs (long EURJPY =
-- long EUR notional, short JPY notional) and netted per currency across
-- a book; crypto positions group by base asset. This directly matches
-- the PRD's own example ("five uncorrelated-looking JPY-cross trades
-- become one concentrated JPY bet" — exactly a JPY currency-cluster
-- concentration) and is fully computable today from live `positions`
-- data plus fx_service.py's FX_MAJOR_CURRENCIES extension (added
-- alongside this migration).
--
-- Book classification: `broker_connections.book` is new schema
-- scaffolding, not a fully-wired feature — 'prop' has ZERO real rows
-- today (Track A hasn't been built) and is a no-op by construction until
-- prop accounts are provisioned in a later pass. `managed_sub_accounts`
-- gets NO new column: a sub-account is Track B ("managed_client") by
-- construction (the table only exists for that pathway) — storing a
-- redundant value there would be a second, possibly-disagreeing source
-- of truth for a fact the schema already guarantees structurally.
--
-- Scoping key is (book_type, book_scope_id), not book_type alone — a
-- single global 'self_directed' bucket would net one user's JPY shorts
-- against an unrelated user's JPY longs, which isn't real concentration
-- risk. self_directed scopes by user_id; managed_client scopes by
-- managed_traders.id (one trader's strategy fans out to every client
-- sub-account simultaneously — the PRD's own scenario, for real, on
-- Track B); prop scopes to one fixed sentinel id (see
-- portfolio_risk/scope.py's PROP_BOOK_SCOPE_ID).
--
-- book_risk_state is NOT period-scoped: one row per (book_type,
-- book_scope_id), never per calendar month. A trip persists across a
-- month rollover until manually cleared — a fresh month must not
-- silently re-enable auto-trading, matching the PRD's "requires human
-- review before re-enabling." Clearing a trip in v1 is a direct
-- service-role row update (no admin UI/route built here), consistent
-- with this codebase's other UI-less admin singleton tables
-- (payout_settings, dispute_settings) — a dedicated clearing route is a
-- reasonable follow-up, not attempted in this pass.
--
-- The circuit breaker DETECTS and BLOCKS NEW auto-trades only. It cannot
-- flatten existing positions — no execution adapter places real orders
-- anywhere in this codebase yet (decision_gate/execution_adapter.py's
-- NullExecutionAdapter is still the only implementation, the same gap
-- decision_gate/cooldown.py's own module docstring already documents for
-- its unrelated -10%/daily mechanism). portfolio_risk/service.py logs
-- this explicitly at trip time rather than silently pretending to
-- flatten anything.
-- ============================================================================

alter table public.broker_connections
  add column book text not null default 'self_directed' check (book in ('self_directed', 'prop'));

comment on column public.broker_connections.book is
  'self_directed (default) or prop (VaultPoint''s own capital — schema scaffolding only, zero real rows until Track A is built). managed_sub_accounts has no equivalent column — a sub-account is Track B/managed_client by construction. See this migration''s header comment.';

-- Decision Gate's cheap synchronous read target (services/broker-sync/app/
-- portfolio_risk/gate_check.py) — written once per cycle by the
-- aggregator job (portfolio_risk/service.py), never recomputed inline on
-- Decision Gate's own 60s pass.
create table public.book_exposure_state (
  id uuid primary key default gen_random_uuid(),
  book_type text not null check (book_type in ('self_directed', 'managed_client', 'prop')),
  book_scope_id uuid not null,
  currency_or_asset text not null,
  net_notional_usd numeric not null,
  position_count integer not null default 0,
  computed_at timestamptz not null default now(),
  unique (book_type, book_scope_id, currency_or_asset)
);

create index idx_book_exposure_state_scope on public.book_exposure_state (book_type, book_scope_id);

comment on table public.book_exposure_state is
  'Live net USD-equivalent exposure per (book, currency/asset), upserted every portfolio_risk cycle. currency_or_asset is an FX/metal currency code (JPY, XAU, ...) or a crypto base asset (BTC, ETH, ...) from portfolio_risk/exposure.py''s classify_symbol().';

-- Baseline equity + circuit-breaker trip lifecycle. One row per
-- (book_type, book_scope_id) — see header comment for why this is not
-- period-scoped.
create table public.book_risk_state (
  id uuid primary key default gen_random_uuid(),
  book_type text not null check (book_type in ('self_directed', 'managed_client', 'prop')),
  book_scope_id uuid not null,
  baseline_equity numeric not null,
  -- managed_allocation: sum(managed_sub_accounts.allocated_amount) — a
  -- real, principled figure. position_proxy: sum(positions.margin_used)
  -- — an APPROXIMATION (no universal live-equity feed exists for
  -- self_directed/prop books), flagged here and in code comments, same
  -- posture as decision_gate/cooldown.py's own Phase 3 gap.
  baseline_source text not null check (baseline_source in ('managed_allocation', 'position_proxy')),
  baseline_period_start date not null,
  current_drawdown_pct numeric,
  tripped boolean not null default false,
  tripped_at timestamptz,
  requires_human_review boolean not null default false,
  cleared_at timestamptz,
  cleared_by uuid references public.users(id),
  updated_at timestamptz not null default now(),
  unique (book_type, book_scope_id)
);

comment on table public.book_risk_state is
  'Book-level drawdown circuit breaker state — see this migration''s header comment for why it is not period-scoped and why clearing a trip has no UI/route in v1.';

alter table public.book_exposure_state enable row level security;
alter table public.book_risk_state enable row level security;

-- Admin-visibility only — no client write policy for any role. All
-- writes are service-role, from portfolio_risk/service.py, same posture
-- as decision_gate_log/candidate_setups.
create policy "Admins can view book exposure state"
  on public.book_exposure_state for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view book risk state"
  on public.book_risk_state for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create trigger set_updated_at before update on public.book_risk_state
  for each row execute procedure public.set_updated_at();

-- Extend decision_gate_log's decision enum for the two new auto-path
-- rejection reasons (drop/re-add — same shape 20260814000003 already
-- used to extend a different CHECK constraint elsewhere in this schema).
alter table public.decision_gate_log drop constraint decision_gate_log_decision_check;
alter table public.decision_gate_log add constraint decision_gate_log_decision_check
  check (decision in (
    'alert_sent', 'manual_approved', 'manual_denied', 'manual_expired',
    'auto_approved_pending_execution_wiring', 'auto_approved_executed',
    'auto_rejected_confidence', 'auto_rejected_sizing', 'auto_rejected_cooldown',
    'auto_rejected_hedging_not_verified',
    'auto_rejected_circuit_breaker', 'auto_rejected_concentration_cap'
  ));

-- down
-- alter table public.decision_gate_log drop constraint decision_gate_log_decision_check;
-- alter table public.decision_gate_log add constraint decision_gate_log_decision_check
--   check (decision in ('alert_sent','manual_approved','manual_denied','manual_expired',
--   'auto_approved_pending_execution_wiring','auto_approved_executed','auto_rejected_confidence',
--   'auto_rejected_sizing','auto_rejected_cooldown','auto_rejected_hedging_not_verified'));
-- drop trigger set_updated_at on public.book_risk_state;
-- drop table public.book_risk_state;
-- drop table public.book_exposure_state;
-- alter table public.broker_connections drop column book;
