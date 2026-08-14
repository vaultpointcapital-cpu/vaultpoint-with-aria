# Aria Managed Mode — Decisioning Logic & Guardrails

Status: documents the **as-built** system (`services/broker-sync/app/managed_mode.py`, 363 lines,
fully implemented and tested) as of 2026-07-23. This is the most mature piece of the whole Managed
Accounts/Managed Mode surface — genuinely production-quality, not a stub.

## Scope: Managed Mode vs. Signal-Only Mode

Every Elite subscriber's connected broker can run in one of two modes on the *signal execution*
side (separate entirely from Managed Accounts, which is VaultPoint-custodied):

- **Signal-only** (default): signals from Aria appear in the Signal Mode feed; the user taps
  Execute on each one individually. This is `initiated_by = 'user'` in `signal_actions`.
- **Managed Mode**: opted in per `broker_connections` row (`managed_mode_enabled = true`). Aria
  places trades automatically, with no per-signal tap. This is `initiated_by = 'aria'`.

That `initiated_by` column is what the profit-share billing engine keys off of — it's also the
audit trail distinguishing "the user did this" from "Aria did this autonomously," which matters for
both billing and for answering "why did this trade happen" after the fact.

## Eligibility, checked every cycle (not just at opt-in)

`evaluate_managed_mode()` runs on a scheduler tick (`app/scheduler.py`,
`managed_mode_evaluation_interval_seconds`) and re-derives eligibility fresh each time:

1. **Tier check**: only `subscription_tier = 'elite'`. Checked per-connection, per-cycle — a
   downgraded user's connection stops trading autonomously on the very next cycle, not "whenever
   someone notices," and gets `managed_mode_enabled` flipped back to `false` automatically.
2. **Kill switch** (`_kill_switch_tripped`): sums today's (UTC) realized P&L across every
   Aria-initiated, executed trade on that connection. If negative and the loss as a percentage of
   current equity meets or exceeds `managed_mode_daily_loss_limit_pct` (per-connection, capped at
   20% by the DB CHECK constraint), Managed Mode is disabled for that connection immediately —
   before evaluating any further signals this cycle.
3. **Re-check immediately before execution** (`_still_enabled`): `evaluate_managed_mode()` snapshots
   the list of enabled connections once at the top of a cycle. Everything downstream runs against
   that snapshot — so this function re-reads `managed_mode_enabled` from the DB immediately before
   calling `execute_signal()`, closing the gap where a user disabling Managed Mode mid-cycle (or the
   soft-disconnect path) could otherwise still see one more trade land. This bounds the exposure
   window to the time between this check and the execute call, not up to a full ~60s cycle.

## Which signals get auto-executed

- Only `status = 'active'`, `min_tier = 'elite'` signals.
- Only `confidence in ('medium', 'high')` — **low-confidence signals are never auto-executed**, even
  for an opted-in Managed Mode connection. They still surface in the manual Signal Mode feed. Aria
  does not autonomously act on a signal it's least sure about.
- Never re-acts on a signal the user already has any non-`'failed'` `signal_actions` row for
  (whether they executed it manually or Aria already tried it) — no duplicate execution.

## Position sizing — risk-based, never a fixed size

`_compute_size`: `risk_amount / stop_distance`, where `risk_amount = equity * (managed_mode_risk_pct
/ 100)`. Capped at 5% equity risk per trade by the DB CHECK constraint. If the signal's stop
distance is `<= 0` (a malformed signal), sizing returns `None` and the signal is skipped — never
guessed.

`_finalize_size` then converts that underlying-unit result into whatever `execute_signal()`'s
`size` actually means per broker: passed through unchanged for Bybit (units = qty for linear
contracts), divided by contract size for MetaTrader (units → lots), reusing the exact same
contract-size lookup `sync_service.py` already uses for position reporting. The code comment is
explicit about why this conversion is handled deliberately rather than assumed: getting MT
lot/unit sizing backwards is a classic silent 100x (or 1/100th) order-size bug.

Both equity (for sizing) and equity (for the kill switch) are read **fresh** from the broker each
time they're needed — never cached/reused stale values across a cycle.

## Failure handling

A failed `execute_signal()` call (broker rejection, network error, etc.) records a `signal_actions`
row with `action = 'failed'` and the failure reason — same audit trail either way, success or
failure. One signal failing does not affect any other signal or connection in the same cycle
(`evaluate_managed_mode`'s per-connection try/except, matching the same per-item isolation pattern
as `alert_engine.py`'s `evaluate_all_alerts`).

## What Managed Mode does *not* do (by design, not gap)

- Never trades on a connection without `trade_execution_enabled = true` already set *and*
  `managed_mode_consented_at` set (explicit consent flow, `POST /api/brokers/:id/managed-mode`) —
  the DB CHECK constraint (`broker_connections_managed_mode_requires_setup`) makes this
  unconditional, not app-code-dependent.
- Never exceeds the 5%-per-trade / 20%-daily-loss caps — both are DB-enforced upper bounds, not
  just application defaults a caller could bypass.
- Never executes a low-confidence signal autonomously.

## How this relates to Managed Accounts (the custodial product)

**Nothing in this file applies to `managed_accounts` today.** Managed Mode's signal source is the
existing Signal Mode feed (`signals`/`signal_actions`/`signal_outcomes`), scoped to a user's *own*
`broker_connections`. A Managed Account has no equivalent signal feed, no risk-sizing logic, and no
scheduler evaluation anywhere — as the architecture doc covers, nothing executes trades on a
`managed_accounts` row at all yet.

If/when a Managed Accounts trading engine gets built, it should **not** simply be pointed at this
same code, for two reasons worth deciding explicitly rather than defaulting into:

1. Managed Mode is *signal-following* — Aria auto-executes signals also shown to signal-only users.
   A Managed Account is *fully discretionary* per its own disclosure text ("VaultPoint's authority
   to trade this account is limited to the scope of the authorization... bound by the stated
   drawdown policy") — there's no reason its trades need to correspond 1:1 with the public signal
   feed, and doing so would mean every Managed Account client gets identical trades, which may or
   may not be the intended product.
2. Managed Mode's risk model (% of equity per trade, tied to a signal's own stop-loss distance) is
   built for a self-directed retail account. A custodial fund managing multiple clients' capital
   typically wants portfolio-level risk controls (aggregate exposure across accounts, correlation
   limits), not just per-account, per-trade sizing — worth deciding whether that matters at
   VaultPoint's expected Managed Accounts scale before building the simpler per-account version and
   having to redo it.
