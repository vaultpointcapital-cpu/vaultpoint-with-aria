-- ============================================================================
-- Aria Autonomous Trading Agent — Decision Gate (PRD Sprint 3, component 4C)
-- ============================================================================
-- Per-account opt-in for the NEW SMC scanner/signal-engine pipeline
-- (candidate_setups/signal_scores), deliberately a DIFFERENT flag from
-- broker_connections.managed_mode_enabled (20260718000002_add_managed_mode.sql).
-- managed_mode_enabled drives the OLDER signal-following Managed Mode
-- feature against the `signals` table; aria_auto_execution_enabled drives
-- this PRD's scanner pipeline. Conflating them would let a user who opted
-- into one silently get auto-execution behavior from the other — kept
-- structurally impossible by having no shared column.
--
-- Same CHECK-constraint-gates-the-risk-fields shape as managed_mode's own
-- migration: no path to true without trade_execution_enabled (or, for a
-- managed sub-account, a signed PoA), a configured risk_pct within the
-- existing 2-5% bound, and an explicit consent timestamp.
--
-- hedging_mode_verified_at is this PRD's own hard constraint (CopyFactory,
-- PRD Sprint 4, does not support MT5 netting accounts) — set only once the
-- broker-sync execution layer has confirmed marginMode=hedging via
-- MetaApi's account-information endpoint. The Decision Gate
-- (app/decision_gate/service.py) treats a null value here as an absolute
-- block on auto-execution, independent of confidence/sizing/cooldown.
-- ============================================================================

alter table public.broker_connections
  add column aria_auto_execution_enabled boolean not null default false,
  add column aria_auto_execution_risk_pct numeric,
  add column aria_auto_execution_daily_loss_limit_pct numeric not null default 10,
  add column aria_auto_execution_consented_at timestamptz,
  add column aria_auto_execution_cooldown_until timestamptz,
  add column hedging_mode_verified_at timestamptz;

alter table public.broker_connections
  add constraint broker_connections_aria_auto_exec_requires_setup
  check (
    not aria_auto_execution_enabled
    or (
      trade_execution_enabled
      and aria_auto_execution_risk_pct is not null
      and aria_auto_execution_risk_pct > 0
      and aria_auto_execution_risk_pct <= 5
      and aria_auto_execution_consented_at is not null
    )
  );

comment on column public.broker_connections.aria_auto_execution_daily_loss_limit_pct is
  'Fixed at the PRD''s own -10%/24h rule by default — deliberately NOT reusing managed_mode_daily_loss_limit_pct''s DB-configurable 5-20% range, a different product''s guardrail. See app/decision_gate/cooldown.py.';
comment on column public.broker_connections.hedging_mode_verified_at is
  'Set only by the broker-sync execution layer once MetaApi confirms this account''s marginMode is hedging, not netting (CopyFactory''s current API does not support copying to netting accounts). Null is an absolute block on Decision Gate auto-execution, checked independently of confidence/sizing/cooldown.';

alter table public.managed_sub_accounts
  add column aria_auto_execution_enabled boolean not null default false,
  add column aria_auto_execution_risk_pct numeric,
  add column aria_auto_execution_daily_loss_limit_pct numeric not null default 10,
  add column aria_auto_execution_consented_at timestamptz,
  add column aria_auto_execution_cooldown_until timestamptz,
  add column hedging_mode_verified_at timestamptz;

alter table public.managed_sub_accounts
  add constraint managed_sub_accounts_aria_auto_exec_requires_setup
  check (
    not aria_auto_execution_enabled
    or (
      poa_signed_at is not null
      and aria_auto_execution_risk_pct is not null
      and aria_auto_execution_risk_pct > 0
      and aria_auto_execution_risk_pct <= 5
      and aria_auto_execution_consented_at is not null
    )
  );

-- Append-only audit trail — every routing decision the Decision Gate
-- makes, whether it results in an alert, an execution, or a rejection.
-- Same shape as managed_account_audit_log (event-style row, no
-- update/delete policy for any role): "Every alert/execution logs
-- confidence score + reasoning for audit" is a named PRD guardrail
-- (SEC Nigeria Managed Trader Pathway relevance), not optional logging.
create table public.decision_gate_log (
  id uuid primary key default gen_random_uuid(),
  signal_score_id uuid not null references public.signal_scores(id),
  account_type text not null check (account_type in ('broker_connection', 'managed_sub_account')),
  account_id uuid not null,
  account_mode text not null check (account_mode in ('manual', 'auto')),
  decision text not null check (decision in (
    'alert_sent',
    'manual_approved',
    'manual_denied',
    'manual_expired',
    'auto_approved_pending_execution_wiring',
    'auto_approved_executed',
    'auto_rejected_confidence',
    'auto_rejected_sizing',
    'auto_rejected_cooldown',
    'auto_rejected_hedging_not_verified'
  )),
  confidence_score numeric not null,
  reasoning text not null,
  position_size numeric,
  cooldown_active boolean not null default false,
  step_up_approval_id uuid references public.step_up_approvals(id),
  created_at timestamptz not null default now()
);

comment on table public.decision_gate_log is
  'Append-only audit trail for every Decision Gate routing decision (app/decision_gate/service.py) — no update/delete policy for any role, ever, same as managed_account_audit_log. No enforced polymorphic FK on (account_type, account_id) since Postgres has none natively; integrity is a write-path guarantee (service-role only) rather than a DB-level one, same trade-off signal_actions.broker_connection_id-style tables already make elsewhere in this schema.';

create index idx_decision_gate_log_account on public.decision_gate_log (account_type, account_id, created_at desc);
create index idx_decision_gate_log_signal_score on public.decision_gate_log (signal_score_id);

alter table public.decision_gate_log enable row level security;

create policy "Admins can view the decision gate log"
  on public.decision_gate_log for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

-- No client insert/update/delete policy for any role — service-role
-- writes only, from the Python Decision Gate job.
