"""Aria Pantheon — shared write path for public.aria_findings.

Every worker (argus, plutus, hermes, mnemosyne — and any future one)
calls upsert_finding() to actually write a finding. This is the one place
"should I write, and does writing risk spam" gets answered, mirroring
connection_health_notifications.py's single-funnel-point shape
(_send/_set_notified_state) rather than each worker re-implementing its
own dedup query.

dedup_key = f"{source_agent}:{finding_type}:{asset}:{severity}". A row
matching this key for this user is reused (raw_data updated in place,
status/timestamps untouched) rather than duplicated while it's still
status='new', or status='delivered' within active_delivered_window_hours
— this is the mechanism that stops e.g. Argus writing a fresh row every
60s while a position sits unchanged at -12%. Argus/Plutus additionally
pre-check positions.argus_last_severity/plutus_last_severity before ever
calling this (cheaper than a query on every position on every cycle);
Hermes/Mnemosyne have no natural per-row column to attach state to and
rely on this function's own query alone.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from ..supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

DEFAULT_ACTIVE_DELIVERED_WINDOW_HOURS = 4.0


def _build_dedup_key(source_agent: str, finding_type: str, asset: str, severity: str) -> str:
    return f"{source_agent}:{finding_type}:{asset}:{severity}"


async def upsert_finding(
    supabase=None,
    *,
    user_id: str,
    source_agent: str,
    finding_type: str,
    severity: str,
    asset: str,
    raw_data: dict,
    active_delivered_window_hours: float = DEFAULT_ACTIVE_DELIVERED_WINDOW_HOURS,
) -> None:
    supabase = supabase or get_service_client()
    dedup_key = _build_dedup_key(source_agent, finding_type, asset, severity)

    existing = await asyncio.to_thread(
        lambda: supabase.table("aria_findings")
        .select("id, status, delivered_at")
        .eq("user_id", user_id)
        .eq("dedup_key", dedup_key)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    active_row = _find_active_row(existing.data, active_delivered_window_hours)

    if active_row is not None:
        await asyncio.to_thread(
            lambda: supabase.table("aria_findings")
            .update({"raw_data": raw_data})
            .eq("id", active_row["id"])
            .execute()
        )
        logger.info(
            "Pantheon finding refreshed (dedup match): user=%s dedup_key=%s", user_id, dedup_key
        )
        return

    await asyncio.to_thread(
        lambda: supabase.table("aria_findings")
        .insert(
            {
                "user_id": user_id,
                "source_agent": source_agent,
                "finding_type": finding_type,
                "severity": severity,
                "raw_data": raw_data,
                "dedup_key": dedup_key,
                "status": "new",
            }
        )
        .execute()
    )
    logger.info("Pantheon finding written: user=%s dedup_key=%s", user_id, dedup_key)


def _find_active_row(rows: list[dict], active_delivered_window_hours: float) -> dict | None:
    if not rows:
        return None
    row = rows[0]
    if row["status"] == "new":
        return row
    if row["status"] == "delivered" and row.get("delivered_at"):
        delivered_at = datetime.fromisoformat(row["delivered_at"])
        if datetime.now(UTC) - delivered_at <= timedelta(hours=active_delivered_window_hours):
            return row
    return None
