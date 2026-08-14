"""Aria Pantheon — Argus (PROTECT): loss/drawdown risk watch.

Runs from sync_service.sync_connection(), right after _reconcile_positions
persists this cycle's rows — reuses the position data already fetched
from the broker this cycle (`rows`), zero extra broker calls. Guarded by
the caller on account_type != 'simulated' — a simulated prop-challenge
account swinging -20% must never trigger a real-feeling loss warning,
same real-only boundary src/lib/aria/compliance.ts and
_upsert_portfolio_snapshot already enforce elsewhere.

Per position: bucket unrealized_pnl_pct into severity, write a finding
only when the bucket actually changed since last cycle —
positions.argus_last_severity is the dedup state for this (see
pantheon/dedup.py's module docstring for why Argus/Plutus get a
pre-check column while Hermes/Mnemosyne don't: those two have no natural
per-row column to attach state to).

Once per call (not per position): a portfolio-level drawdown-from-peak
check, since positions has no per-position stop_loss/peak to compare
against (confirmed: supabase/migrations/20260617000000_initial_schema.sql
only gives positions symbol/side/size/entry_price/mark_price/leverage/
unrealized_pnl/unrealized_pnl_pct/margin_used — stop_loss/take_profit
only exist on the unrelated `signals` table).
"""

import asyncio
import logging

from .dedup import upsert_finding
from .networth import get_current_real_net_worth

logger = logging.getLogger("broker_sync")

_LOSS_THRESHOLDS = (
    (-15, "critical"),
    (-10, "warning"),
    (-5, "caution"),
)
_PORTFOLIO_DRAWDOWN_WARNING_PCT = 15


def _bucket_for_loss(unrealized_pnl_pct: float | None) -> str:
    if unrealized_pnl_pct is None:
        return "none"
    for threshold, severity in _LOSS_THRESHOLDS:
        if unrealized_pnl_pct < threshold:
            return severity
    return "none"


async def evaluate_argus(supabase, connection: dict, rows: list[dict]) -> None:
    user_id = connection["user_id"]
    connection_id = connection["id"]

    states = await _get_position_states(supabase, connection_id)
    for row in rows:
        state = states.get((row["symbol"], row["side"]))
        if state is None:
            # Shouldn't happen given the caller runs this after
            # _reconcile_positions upserts the same rows — but a
            # not-yet-persisted position is a skip, not a crash.
            continue

        bucket = _bucket_for_loss(row.get("unrealized_pnl_pct"))
        if bucket == state["argus_last_severity"]:
            continue

        await _set_severity(supabase, state["id"], bucket)
        if bucket == "none":
            continue

        await upsert_finding(
            supabase,
            user_id=user_id,
            source_agent="argus",
            finding_type="loss_warning",
            severity=bucket,
            asset=row["symbol"],
            raw_data={
                "symbol": row["symbol"],
                "side": row["side"],
                "unrealized_pnl_pct": row.get("unrealized_pnl_pct"),
                "entry_price": row.get("entry_price"),
                "mark_price": row.get("mark_price"),
            },
        )

    await _evaluate_portfolio_drawdown(supabase, user_id)


async def _get_position_states(supabase, connection_id: str) -> dict[tuple[str, str], dict]:
    result = await asyncio.to_thread(
        lambda: supabase.table("positions")
        .select("id, symbol, side, argus_last_severity")
        .eq("broker_connection_id", connection_id)
        .execute()
    )
    return {(r["symbol"], r["side"]): r for r in result.data}


async def _set_severity(supabase, position_id: str, value: str) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("positions")
        .update({"argus_last_severity": value})
        .eq("id", position_id)
        .execute()
    )


async def _evaluate_portfolio_drawdown(supabase, user_id: str) -> None:
    """Mirrors alert_engine.py's own drawdown_pct resolution
    (_resolve_portfolio_value's drawdown_pct branch): same single-currency
    guard (via networth.get_current_real_net_worth), same peak lookup
    against portfolio_snapshots. Peak-relative, not day-over-day — see
    networth.py's module docstring for why this is a distinct concept
    from src/lib/aria/compliance.ts's cool-down rule (also reused by
    hermes.py), which is deliberately NOT peak-relative.
    """
    current_net_worth = await get_current_real_net_worth(supabase, user_id)
    if current_net_worth is None:
        return  # mixed currencies or no data — skip rather than compute a silently wrong sum

    peak_result = await asyncio.to_thread(
        lambda: supabase.table("portfolio_snapshots")
        .select("total_net_worth")
        .eq("user_id", user_id)
        .order("total_net_worth", desc=True)
        .limit(1)
        .execute()
    )
    if not peak_result.data:
        return  # no snapshot history yet — nothing to measure drawdown against

    peak_net_worth = peak_result.data[0]["total_net_worth"]
    if not peak_net_worth or peak_net_worth <= 0:
        return

    drawdown_pct = ((peak_net_worth - current_net_worth) / peak_net_worth) * 100
    if drawdown_pct <= _PORTFOLIO_DRAWDOWN_WARNING_PCT:
        return

    await upsert_finding(
        supabase,
        user_id=user_id,
        source_agent="argus",
        finding_type="loss_warning",
        severity="warning",
        asset="PORTFOLIO",
        raw_data={
            "drawdown_from_peak_pct": drawdown_pct,
            "current_net_worth": current_net_worth,
            "peak_net_worth": peak_net_worth,
        },
    )
