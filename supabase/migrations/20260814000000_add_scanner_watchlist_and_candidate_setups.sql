-- ============================================================================
-- Aria Autonomous Trading Agent — Scanner Service (PRD Sprint 1, component 4A)
-- ============================================================================
-- Nothing in this codebase today persists "which symbols to scan" — the
-- closest existing thing, src/lib/utils/tradingview.ts's
-- getDefaultMarketSymbol(), is a display-only helper that derives a chart
-- symbol from a user's largest open position, with no table behind it.
-- watchlist_symbols is the net-new config the Scanner Service
-- (services/broker-sync/app/scanner/) reads every cycle.
--
-- candidate_setups is the Scanner's own deterministic output — one row per
-- (symbol, timeframe, structure_type, candle_timestamp) SMC detection
-- (liquidity sweep / BOS / CHoCH / order block retest / FVG fill). The
-- unique constraint is the idempotency guard: re-running a scan cycle over
-- the same closed candle must never produce a duplicate candidate. This
-- table is deliberately separate from the Signal Engine's signal_scores
-- (added in a later migration) — deterministic detection vs. LLM-derived
-- scoring are different write authorities, same separation the codebase
-- already uses for aria_context_snapshots vs. the live tables it snapshots.
--
-- Admin-only read, no client write policy at all — same "backend-authored
-- content" pattern as public.signals/public.aria_findings. raw_detection
-- carries rule-engine internals for audit/debugging, never shown raw to a
-- user.
-- ============================================================================

create table public.watchlist_symbols (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  broker text not null default 'metatrader' check (broker in ('metatrader')),
  timeframe text not null check (timeframe in ('M1', 'M5', 'M15', 'H1', 'H4')),
  scan_interval_seconds integer not null default 300,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, broker, timeframe)
);

comment on table public.watchlist_symbols is
  'Net-new symbol/timeframe universe the Scanner Service (services/broker-sync/app/scanner/service.py) polls every cycle. No user-facing watchlist concept existed anywhere in this codebase before this table.';

create table public.candidate_setups (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  timeframe text not null,
  structure_type text not null
    check (structure_type in (
      'liquidity_sweep', 'bos', 'choch', 'order_block_retest', 'fvg_fill'
    )),
  direction text not null check (direction in ('long', 'short')),
  entry_zone_low numeric not null,
  entry_zone_high numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  risk_reward_ratio numeric not null,
  -- The closed candle whose detection produced this row — idempotency key
  -- material, not a display timestamp (created_at is that).
  candle_timestamp timestamptz not null,
  raw_detection jsonb not null,
  status text not null default 'pending_scoring'
    check (status in ('pending_scoring', 'scored', 'expired', 'superseded')),
  created_at timestamptz not null default now(),
  unique (symbol, timeframe, structure_type, candle_timestamp)
);

comment on table public.candidate_setups is
  'One row per SMC structure detected by the deterministic rules engine (services/broker-sync/app/scanner/rules.py) on a closed candle. status flips to scored once the Signal Engine has scored it exactly once (see signal_scores.candidate_setup_id''s unique constraint) — this table itself never gets a second write from the Signal Engine beyond that status flip.';

create index idx_candidate_setups_status on public.candidate_setups (status, created_at);

alter table public.watchlist_symbols enable row level security;
alter table public.candidate_setups enable row level security;

create policy "Admins can view watchlist symbols"
  on public.watchlist_symbols for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view candidate setups"
  on public.candidate_setups for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

-- No insert/update/delete policy for any client role, ever — both tables
-- are written exclusively by the Scanner Service's service-role Supabase
-- client. Same "no client write on execution-adjacent tables" rule as
-- managed_sub_accounts/managed_account_audit_log
-- (20260725000000_add_managed_trader_pathway.sql) — a broad client write
-- policy on a table like this is exactly the shape of bug fixed in
-- 20260724000001_restore_positions_readonly_policy.sql.

create trigger set_updated_at before update on public.watchlist_symbols
  for each row execute procedure public.set_updated_at();
