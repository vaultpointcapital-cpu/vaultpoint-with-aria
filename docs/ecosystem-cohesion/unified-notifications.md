# Unified Notifications — Current State & Consolidation Spec

## Current state: three separate, non-unified systems

1. **Alerts** (`alert_history` + `aria_conversations`): `alert_engine.py` fires price/P&L/margin/
   drawdown alerts, delivers via email (Resend) and an in-app row in `aria_conversations`
   (`role: 'assistant'`, various `message_type`s like `LOSS_WARNING`/`PROFIT_ALERT`/`RISK_CHECK`).
2. **Managed Accounts** (`managed_account_notifications`): a deliberately **separate** table — its
   own migration explains why: at the time it was built, `aria_conversations`' delivery pipeline was
   believed unfinished/unreliable (that belief turned out to be stale — see below). In-app only, no
   email channel.
3. **Pods**: no notification system at all. A pod hitting its target, a deadline approaching, or a
   missed funding-reminder cadence — none of these produce any notification today, in-app or email.

Aria's own chat surfaces (web widget, Telegram) are a fourth, separate channel in the sense that
they're conversational rather than a notification feed, but worth naming since `aria_conversations`
already blurs the line — an alert delivered there today would show up mixed in with an actual Aria
chat transcript, if anything currently rendered that table's contents (see below).

## A correction surfaced while researching this

`managed_account_notifications`' own migration comment says `aria_conversations`' migration "has
never been applied anywhere" and "no widget UI reads it yet." **That was checked directly against
the live database for this doc: `aria_conversations` is in fact applied on both shadow and live
today** (confirmed as part of applying the batch of missing Managed Accounts migrations to live
just now — see the session's Track D work). The "no widget UI reads it" half is still accurate, confirmed directly: searching the entire
Next.js app for any reference to `aria_conversations` outside its own type definition returns
nothing — no component, no API route, reads from it anywhere. So the underlying data has been
sitting in a table with no UI surface this whole time, regardless of which database it was applied
to. Not something to silently "fix" by merging the tables now — that's a real design decision — but
worth knowing the original migration's stated reasoning was half-right (no reader existed, and
still doesn't) and half-stale (the "never applied" claim, which was already false when written).

## Proposed unification approach

Not a full rebuild — reuse `aria_conversations` as the single in-app notification feed, since it
already has the right shape (`user_id`, `channel`, `role`, `content`, `message_type`) and already
receives alert deliveries:

1. **Extend `message_type`** to cover Managed Accounts' five types (`onboarding_milestone`,
   `distribution_requested`, `distribution_paid`, `withdrawal_window_open`, `drawdown_warning`) and
   add pod-related types (`pod_goal_reached`, `pod_deadline_approaching`) — same CHECK-constraint
   extension pattern already used repeatedly in this codebase (e.g., `payment_provider`).
2. **Route Managed Accounts notifications through the same `deliver_alert_in_app`-style insert**
   instead of a separate table, gaining the email channel for free where it makes sense (e.g.
   `drawdown_warning` — described as the flow's own "must never be suppressed" alert — arguably
   *should* email, not just sit in an in-app feed the client might not check).
3. **Add a pod notification source**: a new, small check (reuse `alert_engine.py`'s scheduling
   pattern) that fires `pod_goal_reached` once when `current_amount` crosses `target_amount`, and
   optionally a deadline-approaching reminder — both currently silent events.
4. **One unread-badge/read-tracking model** instead of two (`aria_conversations` needs a `read_at`
   equivalent if it doesn't have one — `managed_account_notifications.read_at` is purely a UI flag
   today and that pattern is worth keeping, just on the unified table).

## What NOT to do

Don't literally drop `managed_account_notifications` and migrate its existing rows without a plan
— any real client data in there (onboarding milestones already sent) should either migrate cleanly
or the UI should read from both tables during a transition window. This is a "next time you're
touching this area" migration, not an urgent rip-and-replace, given Managed Accounts has no real
client activity yet (the whole feature was non-functional in production until this session's
migration fix).

## Priority relative to the rest of Track D

Lower urgency than the Aria consistency finding (#2 there — the missing risk-cap rule — is a live
correctness issue) and the pods/trading connection's #4 (free UI cohesion). This is real but
nothing is currently broken by having three systems; it's added maintenance burden and a slightly
worse experience (a client might miss a `managed_account_notifications`-only alert if they're used
to checking `aria_conversations`), not a bug.
