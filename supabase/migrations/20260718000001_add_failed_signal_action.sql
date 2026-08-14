-- ============================================================================
-- VaultPoint — Signal Mode: record failed execution attempts
-- ============================================================================
-- Gap found while building the execution path: 20260718000000's
-- signal_actions.action only allowed ('executed', 'skipped', 'ignored') —
-- no way to record that a user tapped Execute and the broker rejected the
-- order (insufficient margin, connection error, symbol not tradeable,
-- etc.). Silently not logging that would violate the spec's own
-- acceptance criteria: "Full audit log of every signal shown, action
-- taken... and outcome." A failed attempt is a real action taken, not
-- nothing.
--
-- failure_reason is populated only for action = 'failed' — the broker's
-- (or this service's) error message, truncated, never anything that
-- would need the encryption module to produce (this is why it's a plain
-- text column, not encrypted: broker rejection reasons are things like
-- "insufficient balance" or "symbol not tradeable", never credentials).
-- ============================================================================

alter table public.signal_actions drop constraint signal_actions_action_check;
alter table public.signal_actions
  add constraint signal_actions_action_check
  check (action in ('executed', 'skipped', 'ignored', 'failed'));

-- Both 'executed' and 'failed' represent an attempted trade — both need
-- broker_connection_id/executed_size (what was attempted); only
-- 'executed' can have a broker_order_id (a failed attempt was never
-- accepted by the broker, so there is no order to reference).
alter table public.signal_actions drop constraint signal_actions_executed_requires_connection;
alter table public.signal_actions
  add constraint signal_actions_executed_requires_connection
  check (
    action not in ('executed', 'failed')
    or (broker_connection_id is not null and executed_size is not null)
  );

alter table public.signal_actions add column failure_reason text;
comment on column public.signal_actions.failure_reason is
  'Populated only when action = ''failed'' — the broker/execution error message (truncated), never credentials or anything requiring decryption.';

-- signal_actions_one_per_user_per_signal (a table-level UNIQUE
-- constraint from 20260718000000) would permanently lock a user out of
-- ever acting on a signal again after a single failed attempt — a
-- transient broker error (e.g. a momentary API outage) shouldn't be
-- unretryable. Replaced with a partial unique index: still only one
-- TERMINAL action per user per signal (executed/skipped/ignored — you
-- can't skip a signal you already executed, or vice versa), but any
-- number of 'failed' rows before a terminal one lands.
alter table public.signal_actions drop constraint signal_actions_one_per_user_per_signal;
create unique index signal_actions_one_terminal_action_per_user_per_signal
  on public.signal_actions(signal_id, user_id)
  where action <> 'failed';
