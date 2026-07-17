-- ============================================================================
-- VaultPoint — Alert Engine: cooldown tracking + drawdown_pct condition type
-- ============================================================================
-- The Alert Engine spec's alert_type list (price_above/below,
-- pnl_pct_above/below, stop_loss_breach, take_profit_hit, drawdown_pct,
-- daily_pnl_pct) was diffed against the already-reconciled canonical
-- shape (condition_type in price/pnl_pct/pnl_abs/margin_pct + a separate
-- operator in above/below — see src/lib/validations/alerts.ts, the
-- existing Alerts page's real contract). Most of the spec's list already
-- has a home there:
--   price_above/price_below   -> condition_type='price'   + operator
--   pnl_pct_above/below,
--   daily_pnl_pct              -> condition_type='pnl_pct'  + operator
--                                 (already portfolio-wide, not per-position
--                                 — daily_pnl_pct is the same shape, just
--                                 evaluated over a day-scoped window by
--                                 the engine, not a new column)
--   stop_loss_breach,
--   take_profit_hit            -> condition_type='price'   + operator
--                                 (a specific price level on one symbol —
--                                 same data shape as any other price
--                                 alert; "stop loss" / "take profit" is a
--                                 UI label choice, not a new backend
--                                 concept)
--
-- Two things were genuinely missing, not just relabeled:
--
-- 1. last_triggered_at — alerts has no column to track when an alert
--    last fired at all, which the engine's cooldown logic (default 4h,
--    per spec) requires to know whether to re-fire.
--
-- 2. drawdown_pct — peak-relative portfolio drawdown is not the same
--    measurement as pnl_pct (point-in-time P&L percent); it requires
--    comparing against a running historical maximum, which pnl_pct's
--    existing meaning doesn't capture. Added as a new condition_type
--    value rather than overloading pnl_pct's semantics.
--
-- Not applying anywhere (local, shadow, or live) — SQL only, per
-- instruction; live is mid-reconciliation and migrations are applied by
-- hand, in order, by the project owner.
-- ============================================================================

alter table public.alerts add column last_triggered_at timestamptz;
comment on column public.alerts.last_triggered_at is
  'Set by the Alert Engine each time this alert fires. Null means never triggered. Used for the cooldown window (default 4h) so a value hovering near the threshold does not spam repeated alerts.';

alter table public.alerts drop constraint alerts_condition_type_check;
alter table public.alerts
  add constraint alerts_condition_type_check
  check (condition_type = any (array['price'::text, 'pnl_pct'::text, 'pnl_abs'::text, 'margin_pct'::text, 'drawdown_pct'::text]));
