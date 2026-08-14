"""Value Ledger — Python-side event emission.

Mirrors src/lib/value-ledger/events.ts: a thin, best-effort wrapper around
the value_ledger_apply_event RPC (supabase/migrations/20260815000000_add_value_ledger.sql).
Callers should treat a failed emit as non-fatal — this module never raises
past apply_event, so a ledger-write failure can't take down the poll cycle
that triggered it.
"""

import asyncio
import logging
from datetime import UTC, datetime

logger = logging.getLogger("broker_sync")


async def apply_event(
    supabase,
    *,
    user_id: str,
    event_name: str,
    idempotency_key: str,
    properties: dict | None = None,
    source: str = "broker_sync",
) -> None:
    await asyncio.to_thread(
        lambda: supabase.rpc(
            "value_ledger_apply_event",
            {
                "p_user_id": user_id,
                "p_event_name": event_name,
                "p_idempotency_key": idempotency_key,
                "p_properties": properties or {},
                "p_source": source,
            },
        ).execute()
    )


async def emit_position_closed_events(supabase, connection: dict, stale_positions: list[dict]) -> None:
    """Best-effort, poll-cycle-granularity close detection — NOT a precise
    close price/time. `stale_positions` is sync_service.py's own
    _get_stale_positions output for this cycle: positions open last poll,
    absent this poll. alert_acted_on/alert_pnl_saved built on top of these
    events in the nightly rollup are correspondingly approximate — a v1
    heuristic, not a backtested figure.
    """
    for p in stale_positions:
        try:
            await apply_event(
                supabase,
                user_id=connection["user_id"],
                event_name="position_closed",
                idempotency_key=f"position_closed:{connection['id']}:{p['symbol']}:{p['side']}:{p.get('synced_at')}",
                properties={
                    "symbol": p["symbol"],
                    "side": p["side"],
                    "size": p.get("size"),
                    "closed_at_approx": datetime.now(UTC).isoformat(),
                },
                source="broker_sync_poller",
            )
        except Exception:
            logger.exception(
                "value_ledger: failed to emit position_closed for connection=%s symbol=%s",
                connection["id"],
                p.get("symbol"),
            )
