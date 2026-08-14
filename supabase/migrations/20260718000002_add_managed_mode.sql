-- ============================================================================
-- VaultPoint — Signal Mode Part 2: Managed Mode (autonomous execution)
-- ============================================================================
-- Managed Mode lets Aria place trades on a user's behalf with no per-signal
-- tap — a materially higher-risk step than Signal Mode's manual Execute
-- button, since it removes the human confirmation that was the load-bearing
-- safety property of everything built so far. Every column here exists to
-- constrain that risk at the database level, not just in application code:
--
-- - managed_mode_enabled can only be set true when trade_execution_enabled
--   is already true (existing Signal Mode requirement) AND the risk
--   parameters below are configured AND the user has completed the consent
--   flow (managed_mode_consented_at is set). There is no path to enabling
--   autonomous trading without all three.
-- - managed_mode_risk_pct bounds what fraction of account equity a single
--   autonomous trade can risk (position size is derived from this and the
--   signal's stop-loss distance, not a raw lot/contract size the user might
--   fat-finger).
-- - managed_mode_daily_loss_limit_pct is the kill-switch threshold: the
--   scheduler checks today's realized P&L against this before every
--   autonomous execution and flips managed_mode_enabled back to false the
--   moment it's breached (see app/managed_mode.py).
-- ============================================================================

alter table public.broker_connections
  add column managed_mode_enabled boolean not null default false,
  add column managed_mode_risk_pct numeric,
  add column managed_mode_daily_loss_limit_pct numeric,
  add column managed_mode_consented_at timestamptz;

alter table public.broker_connections
  add constraint broker_connections_managed_mode_requires_setup
  check (
    not managed_mode_enabled
    or (
      trade_execution_enabled
      and managed_mode_risk_pct is not null
      and managed_mode_risk_pct > 0
      and managed_mode_risk_pct <= 5
      and managed_mode_daily_loss_limit_pct is not null
      and managed_mode_daily_loss_limit_pct > 0
      and managed_mode_daily_loss_limit_pct <= 20
      and managed_mode_consented_at is not null
    )
  );

comment on column public.broker_connections.managed_mode_risk_pct is
  'Percent of account equity risked per autonomous trade (position size is derived from this and the signal''s stop-loss distance). Capped at 5% by the CHECK constraint — this is a per-trade risk bound, not a suggestion the UI is trusted to enforce alone.';
comment on column public.broker_connections.managed_mode_daily_loss_limit_pct is
  'Kill-switch threshold: the scheduler disables managed_mode_enabled for this connection the moment today''s realized loss exceeds this percent of equity. Capped at 20% by the CHECK constraint.';
comment on column public.broker_connections.managed_mode_consented_at is
  'Set only when the user completes the explicit Managed Mode consent flow (POST /api/brokers/:id/managed-mode). Null blocks managed_mode_enabled=true regardless of any other field.';

-- Distinguishes a signal_actions row the user tapped Execute on from one
-- Aria placed autonomously under Managed Mode. Both the audit trail
-- ("who actually took this action") and the profit-share billing engine
-- (which must only bill on Aria-attributed trades, never trades the user
-- placed themselves) depend on this being reliable at the DB level, not
-- inferred from which code path happened to run.
alter table public.signal_actions
  add column initiated_by text not null default 'user'
  check (initiated_by in ('user', 'aria'));

comment on column public.signal_actions.initiated_by is
  '''aria'' only for Managed Mode autonomous executions (app/managed_mode.py). Never set by the Next.js /api/signals/[id]/execute route, which is exclusively user-initiated taps — that route''s inserts always default to ''user''.';
