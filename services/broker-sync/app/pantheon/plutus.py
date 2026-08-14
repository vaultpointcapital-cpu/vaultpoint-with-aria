"""Aria Pantheon — Plutus (PROFIT): take-profit / gain milestone watch.

Same cadence and same position data as Argus (see argus.py's module
docstring for the call-site/dedup-column reasoning) — called right after
Argus in sync_service.sync_connection() on the same already-fetched
`rows`, zero extra broker calls.

severity is always 'info' or 'caution', never 'warning'/'critical' — a
profit milestone is never urgent enough to justify proactive outreach;
src/lib/aria/findings.ts's proactive query filters on
severity in ('warning','critical'), so Plutus findings structurally
can't reach the proactive delivery path regardless of this choice, but
picking info/caution here keeps that intent legible at the source too.
"""

import asyncio
import logging

from .dedup import upsert_finding

logger = logging.getLogger("broker_sync")

# (threshold, severity, suggest_take_pct_range) — evaluated highest first.
_PROFIT_THRESHOLDS = (
    (50, "caution", [70, 100]),
    (30, "caution", [50, 70]),
    (15, "info", [30, 50]),
)


def _bucket_for_profit(unrealized_pnl_pct: float | None) -> tuple[str, list[int] | None]:
    if unrealized_pnl_pct is None:
        return "none", None
    for threshold, severity, suggest_range in _PROFIT_THRESHOLDS:
        if unrealized_pnl_pct > threshold:
            return severity, suggest_range
    return "none", None


async def evaluate_plutus(supabase, connection: dict, rows: list[dict]) -> None:
    user_id = connection["user_id"]
    connection_id = connection["id"]

    states = await _get_position_states(supabase, connection_id)
    for row in rows:
        state = states.get((row["symbol"], row["side"]))
        if state is None:
            continue

        bucket, suggest_range = _bucket_for_profit(row.get("unrealized_pnl_pct"))
        if bucket == state["plutus_last_severity"]:
            continue

        await _set_severity(supabase, state["id"], bucket)
        if bucket == "none":
            continue

        await upsert_finding(
            supabase,
            user_id=user_id,
            source_agent="plutus",
            finding_type="profit_alert",
            severity=bucket,
            asset=row["symbol"],
            raw_data={
                "symbol": row["symbol"],
                "side": row["side"],
                "unrealized_pnl_pct": row.get("unrealized_pnl_pct"),
                "entry_price": row.get("entry_price"),
                "mark_price": row.get("mark_price"),
                "suggest_take_pct_range": suggest_range,
            },
        )


async def _get_position_states(supabase, connection_id: str) -> dict[tuple[str, str], dict]:
    result = await asyncio.to_thread(
        lambda: supabase.table("positions")
        .select("id, symbol, side, plutus_last_severity")
        .eq("broker_connection_id", connection_id)
        .execute()
    )
    return {(r["symbol"], r["side"]): r for r in result.data}


async def _set_severity(supabase, position_id: str, value: str) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("positions")
        .update({"plutus_last_severity": value})
        .eq("id", position_id)
        .execute()
    )
