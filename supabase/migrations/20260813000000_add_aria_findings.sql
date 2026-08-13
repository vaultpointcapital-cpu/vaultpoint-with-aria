-- ============================================================================
-- Aria Pantheon — Multi-Agent Orchestration
-- ============================================================================
-- Below Aria (the only agent that spends LLM tokens or talks to the user)
-- sits a council of cheap, deterministic worker agents that write
-- structured findings here. Aria reads findings and decides what reaches
-- the user and how it's phrased — workers never message the user directly.
--
-- v1 ships four workers: argus (loss/risk, services/broker-sync/app/
-- pantheon/argus.py), plutus (profit, .../plutus.py), hermes (opportunity
-- scouting, .../hermes.py), mnemosyne (periodic reports, .../mnemosyne.py).
-- nike (community nudges) and themis (compliance gating) are reserved in
-- the check constraint below but have no worker module in v1 — adding one
-- later means a new worker file plus a new value in source_agent, nothing
-- changes on Aria's read side (src/lib/aria/findings.ts).
--
-- Dedup: see services/broker-sync/app/pantheon/dedup.py's module
-- docstring for the full policy. Short version: dedup_key is
-- "{source_agent}:{finding_type}:{asset}:{severity}" — a row is reused
-- (raw_data updated in place, status/timestamps untouched) rather than
-- duplicated while status is 'new', or 'delivered' within the last 4
-- hours.
-- ============================================================================

create table public.aria_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  source_agent text not null
    check (source_agent in ('argus', 'plutus', 'hermes', 'mnemosyne', 'nike', 'themis')),
  finding_type text not null
    check (finding_type in (
      'loss_warning', 'profit_alert', 'buy_signal', 'portfolio_review',
      'market_update', 'risk_check', 'community_nudge'
    )),
  severity text not null check (severity in ('info', 'caution', 'warning', 'critical')),
  raw_data jsonb not null,          -- the numbers only — never pre-written copy (Aria writes the copy)
  dedup_key text not null,
  status text not null default 'new'
    check (status in ('new', 'acknowledged', 'delivered', 'dismissed', 'expired')),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  delivered_at timestamptz
);

create index aria_findings_user_status_idx on public.aria_findings (user_id, status);
create index aria_findings_user_dedup_idx on public.aria_findings (user_id, dedup_key);

alter table public.aria_findings enable row level security;

create policy "Users can view their own Aria findings"
  on public.aria_findings for select
  using (user_id = auth.uid());

-- No insert/update/delete policy for any client role — findings are only
-- ever written by the Python worker modules (service-role) and updated by
-- the Next.js reactive/proactive routes (also service-role), same
-- "backend-authored content" pattern as public.signals and
-- public.aria_conversations.

-- down
-- drop table public.aria_findings;
