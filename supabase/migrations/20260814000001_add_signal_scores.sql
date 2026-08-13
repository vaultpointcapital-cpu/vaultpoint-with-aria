-- ============================================================================
-- Aria Autonomous Trading Agent — Signal Engine (PRD Sprint 2, component 4B)
-- ============================================================================
-- One row per candidate_setups row Aria/Claude has scored — the Signal
-- Engine (services/broker-sync/app/signal_engine/) calls Claude exactly
-- once per candidate (never per candle, per the PRD's own cost/latency
-- rule), so unique(candidate_setup_id) is the DB-level enforcement of that
-- rule, not just an application-level check.
--
-- Deliberately its own table rather than columns bolted onto
-- candidate_setups: the Scanner's deterministic detection and the Signal
-- Engine's LLM-derived judgment are different write authorities (the
-- Scanner never writes here; the Signal Engine never writes to
-- candidate_setups beyond flipping its status to 'scored') — same
-- separation this codebase already uses for aria_context_snapshots vs.
-- the live tables it snapshots.
-- ============================================================================

create table public.signal_scores (
  id uuid primary key default gen_random_uuid(),
  candidate_setup_id uuid not null references public.candidate_setups(id),
  confidence_score numeric not null check (confidence_score >= 0 and confidence_score <= 100),
  action_class text not null check (action_class in ('ALERT_ONLY', 'AUTO_ELIGIBLE', 'REJECT')),
  reasoning text not null,
  key_risk_factors jsonb not null default '[]'::jsonb,
  macro_context jsonb not null default '{}'::jsonb,
  account_risk_profile_used jsonb not null default '{}'::jsonb,
  model text not null default 'claude-sonnet-5',
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now(),
  unique (candidate_setup_id)
);

comment on table public.signal_scores is
  'One Claude scoring result per candidate_setups row (services/broker-sync/app/signal_engine/scorer.py). unique(candidate_setup_id) enforces "score once per candidate, not once per candle" at the DB level. Admin-only read, no client write policy — service-role writes only, same as candidate_setups/watchlist_symbols.';

create index idx_signal_scores_action_class on public.signal_scores (action_class, created_at);

alter table public.signal_scores enable row level security;

create policy "Admins can view signal scores"
  on public.signal_scores for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));
