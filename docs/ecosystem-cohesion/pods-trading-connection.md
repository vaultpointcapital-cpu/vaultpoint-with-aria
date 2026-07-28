# Savings Pods + Active Trading — Connection Spec (Proposal)

Status: **Pods and trading are two completely disconnected systems today.** No code anywhere
references both — confirmed by searching the broker-sync service (which owns all trading/position
logic) for any mention of pods at all: zero matches. This doc proposes concrete connection points
grounded in what already exists on both sides, not a description of something already built.

## What exists on each side today

**Pods**: `savings_pods` (target amount, current amount, deadline, color, an informational-only
`funding_reminder` — see the Managed Accounts docs for why that's a reminder, not automation) +
`pod_contributions` (manual, user-initiated top-ups only).

**Trading**: `positions` (live synced balances), `signals`/`signal_actions`/`signal_outcomes`
(Signal Mode manual + Managed Mode autonomous execution), `alerts`/`alert_history` (price/P&L/risk
alerts).

Nothing currently reads pod state when making a trading decision, and nothing reads trading
outcomes when updating a pod.

## Proposed connection points, roughly in order of how safe/simple they are to build

### 1. Profit-to-pod sweep (safest, purely additive)

When a Signal Mode or Managed Mode trade closes with realized profit, offer (or, if a user opts in,
automatically) route a percentage of that realized profit into a designated pod as a
`pod_contributions` row. This is the most natural "trading feeds savings" loop and requires no new
trust boundary — it's just an additional `pod_contributions` insert triggered from
`signal_outcomes` once a trade closes, alongside the profit-share billing computation that already
reads from that same table. Needs a decision: opt-in per pod, or a global "sweep X% of all trading
profit" setting?

### 2. Pod-aware risk alerts (low effort, reuses existing alert infrastructure)

`alert_engine.py` already evaluates portfolio-wide P&L/drawdown/margin conditions on a schedule.
Extending `condition_type` with a pod-aware variant (e.g., "alert if a losing trade would set back
pod X's timeline by more than N days," computed from the pod's contribution rate and current
progress) reuses the entire existing alert delivery pipeline (email + in-app) rather than building
new infrastructure. Lower priority than #1 — more of a "nice to have" cross-sell of the alerts
feature than a core loop.

### 3. Pod-gated risk limits (bigger decision, touches Managed Mode's guardrails)

A more opinionated version: let a user mark a pod as "protected," and have Managed Mode's
kill-switch (`managed_mode_daily_loss_limit_pct`, see the Aria Managed Mode doc) tighten
automatically if a loss would eat into money earmarked for that pod. This is a real, meaningful
feature but touches the exact guardrail code that already has the most scrutiny in this codebase
(`managed_mode.py`'s own docstring: "changes here deserve the same scrutiny as that migration") —
worth treating as its own careful piece of work, not bundled into a general "pods integration" pass.

### 4. Dashboard-level visual connection only (no new backend, purely cohesion)

Simplest possible version if the above feels like too much new surface area for now: just show pod
progress and open positions on the same dashboard view with a shared "this is what your trading is
funding" framing — zero new tables, zero new logic, purely a UI/copy change. Worth doing regardless
of whether 1-3 get built, since it costs almost nothing and directly addresses "the loop between
savings pods and active trading behavior" the checklist names, even if the loop stays visual/manual
rather than automated.

## Recommendation

Start with #4 (free, immediate) and #1 (real automation, contained blast radius, no new trust
boundary) before considering #2 or #3. #3 in particular should wait for an explicit decision that
it's wanted — it's the one option here that changes real trading risk behavior, not just where
money ends up after a trade closes.
