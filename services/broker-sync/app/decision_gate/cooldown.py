"""Decision Gate cool-down (PRD Sprint 3, component 4C) — the PRD's own
fixed "-10% daily loss -> 24h pause" guardrail, enforced at the Decision
Gate rather than only in chat.

This is a genuinely distinct mechanism from the other two cool-downs
already in this codebase, not a shared implementation:
  - src/lib/aria/compliance.ts's computeCoolDown(): 10% same-day drop
    suppresses Aria CHAT buy suggestions only — a prompt-shaping concern,
    no execution-layer enforcement at all.
  - managed_mode.py's _kill_switch_tripped(): sums realized P&L from
    signal_actions/signal_outcomes rows scoped to the OLDER Managed Mode
    feature, against a DB-configurable 5-20% cap.
This module's is_in_cooldown()/trip_cooldown() are the enforcement
primitives for THIS PRD's fixed -10%/24h rule, stored on
aria_auto_execution_cooldown_until (broker_connections/managed_sub_accounts,
see the Sprint 3 migration).

Scope note: automatically COMPUTING today's realized loss and calling
trip_cooldown() from it needs a per-account trade-outcome history for
THIS pipeline (candidate_setups/signal_scores-driven trades) to sum —
which does not exist yet, because Phase 2 ships execution stubbed behind
NullExecutionAdapter (see execution_adapter.py); there is nothing to sum.
Reusing an unrelated metric (e.g. Hermes's whole-portfolio net-worth
comparison) here would be actively wrong: this cool-down must be scoped
to one account, not a user's entire portfolio, or it would pause (or fail
to pause) accounts based on losses/gains that have nothing to do with
them. trip_cooldown() itself is fully real and callable today — wiring
its automatic trigger from real per-account P&L is Phase 3 scope, once
CopyFactoryExecutionAdapter produces real, attributable trade outcomes to
sum. Flagged, not silently faked.
"""

import asyncio
from datetime import UTC, datetime, timedelta

from ..config import settings

_TABLE_BY_ACCOUNT_TYPE = {
    "broker_connection": "broker_connections",
    "managed_sub_account": "managed_sub_accounts",
}


def is_in_cooldown(account: dict) -> bool:
    cooldown_until = account.get("aria_auto_execution_cooldown_until")
    if not cooldown_until:
        return False
    return datetime.fromisoformat(cooldown_until) > datetime.now(UTC)


async def trip_cooldown(supabase, account_type: str, account_id: str) -> None:
    table = _TABLE_BY_ACCOUNT_TYPE[account_type]
    cooldown_until = datetime.now(UTC) + timedelta(hours=settings.decision_gate_cooldown_hours)
    await asyncio.to_thread(
        lambda: supabase.table(table)
        .update({"aria_auto_execution_cooldown_until": cooldown_until.isoformat()})
        .eq("id", account_id)
        .execute()
    )
