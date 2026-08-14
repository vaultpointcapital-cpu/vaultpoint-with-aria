-- ============================================================================
-- VaultPoint — Aria Signal Mode (Part 1 of the Signal Mode + Profit-Share spec)
-- ============================================================================
-- Part 2 of that spec (profit-share billing / Managed Mode) is explicitly
-- gated in its own text on legal clearance that hasn't happened yet — no
-- schema for that here. This migration is Part 1 only: the signal feed,
-- per-signal user actions (execute/skip/ignored), and outcomes for the
-- track record stat.
--
-- Design decision, confirmed explicitly before writing this: broker
-- connection trade permission is per-connection opt-in, not a platform-
-- wide policy change. Every existing connection keeps the read-only
-- promise broker_connections.is_read_only already makes ("enforced UX:
-- platform never trades" — see that column's original comment). A
-- connection only becomes execute-capable if the user explicitly
-- re-authorizes it with trade-permission keys, which is what
-- trade_execution_enabled represents below. The CHECK constraint makes
-- it impossible for a connection to be flagged execute-capable while
-- still marked read-only, at the database level, not just in application
-- logic.
--
-- Signals themselves are not per-user — the same signal (pair, direction,
-- entry/stop/target, rationale) is shown to every eligible user; tier
-- gating (Free: delayed/limited, Pro/Elite: real-time) is enforced at the
-- application layer reading this table, not via RLS, the same pattern
-- already used for Alert/Pod tier limits in this codebase.
-- ============================================================================

alter table public.broker_connections add column trade_execution_enabled boolean not null default false;
comment on column public.broker_connections.trade_execution_enabled is
  'Per-connection opt-in for Signal Mode execution. A user must explicitly re-authorize this specific connection with trade-permission (non-read-only) keys before Aria can place orders through it — existing connections are unaffected and stay read-only.';

alter table public.broker_connections
  add constraint broker_connections_trade_requires_non_readonly
  check (not trade_execution_enabled or is_read_only = false);

-- ----------------------------------------------------------------------------
-- signals — Aria's trade ideas, one row per idea, shared across all
-- eligible users (not personalized per-user).
-- ----------------------------------------------------------------------------
create table public.signals (
  id uuid primary key default gen_random_uuid(),
  pair text not null,
  direction text not null check (direction in ('long', 'short')),
  entry_price numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  risk_reward_ratio numeric not null,
  rationale text not null,
  confidence text check (confidence is null or confidence in ('low', 'medium', 'high')),
  min_tier text not null default 'pro' check (min_tier in ('free', 'pro', 'elite')),
  status text not null default 'active' check (status in ('active', 'closed', 'invalidated')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

comment on column public.signals.min_tier is
  'Lowest tier that can see this signal at all. Free-tier delay/limiting (spec: "1 per week as a taste") is separate application logic on top of this, not a column here — it is about which of the signals a Free user is allowed to see this week, not a property of the signal itself.';

create index idx_signals_status_created on public.signals(status, created_at desc);

alter table public.signals enable row level security;
create policy "Authenticated users can view signals" on public.signals
  for select using (auth.role() = 'authenticated');
-- No insert/update/delete policy for any client role — signals are only
-- ever written by the backend's service-role client (Aria's signal
-- generation), matching the academy_videos/aria_conversations pattern
-- already used in this schema for backend-authored content.

-- ----------------------------------------------------------------------------
-- signal_actions — what a specific user did with a specific signal.
-- One row per (signal, user) — a user can only act on a given signal once,
-- matching "user taps Execute or Skip", not both.
-- ----------------------------------------------------------------------------
create table public.signal_actions (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.signals(id) not null,
  user_id uuid references public.users(id) not null,
  broker_connection_id uuid references public.broker_connections(id),
  action text not null check (action in ('executed', 'skipped', 'ignored')),
  executed_size numeric,
  broker_order_id text,
  created_at timestamptz not null default now(),
  constraint signal_actions_one_per_user_per_signal unique (signal_id, user_id),
  constraint signal_actions_executed_requires_connection
    check (action <> 'executed' or (broker_connection_id is not null and executed_size is not null))
);

comment on column public.signal_actions.broker_order_id is
  'The broker''s own order/position reference for this execution — needed to reconcile signal_outcomes against what actually happened on the broker side, not just what VaultPoint requested.';

create index idx_signal_actions_user on public.signal_actions(user_id, created_at desc);

alter table public.signal_actions enable row level security;
create policy "Users can view own signal actions" on public.signal_actions
  for select using (auth.uid() = user_id);
create policy "Users can create own signal actions" on public.signal_actions
  for insert with check (auth.uid() = user_id);
-- No update/delete: an action, once taken (executed/skipped/ignored), is
-- final — matches alert_history's append-only precedent elsewhere in
-- this schema. A wrong "executed" row is corrected by the actual broker
-- state and signal_outcomes, not by editing this row after the fact.

-- ----------------------------------------------------------------------------
-- signal_outcomes — result once an executed trade closes. Only
-- signal_actions rows with action = 'executed' ever get one; skipped/
-- ignored actions never produce an outcome, per the acceptance criteria
-- ("Track record stat... calculated only from Execute actions with a
-- closed outcome").
-- ----------------------------------------------------------------------------
create table public.signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  signal_action_id uuid references public.signal_actions(id) not null unique,
  result text not null check (result in ('win', 'loss', 'breakeven')),
  realized_pnl numeric not null,
  realized_r_multiple numeric,
  closed_at timestamptz not null default now()
);

alter table public.signal_outcomes enable row level security;
create policy "Users can view own signal outcomes" on public.signal_outcomes
  for select using (
    exists (
      select 1 from public.signal_actions sa
      where sa.id = signal_outcomes.signal_action_id and sa.user_id = auth.uid()
    )
  );
-- No client insert/update: outcomes are written by the backend once a
-- broker-reported position closes, same trust boundary as
-- portfolio_snapshots and alert_history.
