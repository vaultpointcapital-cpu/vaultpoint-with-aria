"""Withdrawal detection (Automated Profit-Split Payout Calculation spec,
section 3.1) — the missing piece: nothing in this service persists or
diffs MT5 balances today. get_balance() is called for simulated
connections only as a liveness probe (sync_service.py); this module is
what actually stores and compares it.

Heuristic, not verified against real Hantec withdrawal behavior — same
"best-effort, flagged" disclosure as MetaTraderAuthError's docstring in
brokers/metatrader.py. Tune the constants below against real data before
relying on confidence='auto_detected' for anything consequential:
'auto_detected' still requires an admin action before any collection step
(calling calculate_payout_split only records the split — it does not
authorize or execute a payout), it only skips the "is this even real"
confirmation step a messier detection needs.
"""

import asyncio
import logging
from datetime import UTC, datetime

import httpx

from .brokers.metatrader import MetaTraderClient
from .config import settings
from .encryption import decrypt
from .models import BrokerType
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

# A drop this small is within normal spread/swap noise, not worth flagging.
MIN_WITHDRAWAL_AMOUNT = 1.0


async def detect_withdrawal_events() -> None:
    supabase = get_service_client()

    agreements_result = await asyncio.to_thread(
        lambda: supabase.table("prop_payout_agreements").select("*").eq("active", True).execute()
    )
    agreements = agreements_result.data or []
    if not agreements:
        return

    connection_ids = [a["broker_connection_id"] for a in agreements]
    connections_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .select("*")
        .in_("id", connection_ids)
        .neq("health", "closed")
        .execute()
    )

    for connection in connections_result.data or []:
        try:
            await _detect_for_connection(supabase, connection)
        except Exception:
            logger.exception("detect_withdrawal_events: failed for connection=%s", connection.get("id"))


async def _detect_for_connection(supabase, connection: dict) -> None:
    connection_id = connection["id"]

    if connection["broker"] != BrokerType.METATRADER.value:
        return  # prop-funded accounts are MetaTrader-only today (Hantec)

    client = _build_client(connection)
    try:
        balance = await client.get_balance()
    except Exception:
        logger.exception("detect_withdrawal_events: could not read balance for connection=%s", connection_id)
        return
    finally:
        await client.aclose()

    prior_result = await asyncio.to_thread(
        lambda: supabase.table("account_balance_snapshots")
        .select("balance, synced_at")
        .eq("broker_connection_id", connection_id)
        .order("synced_at", desc=True)
        .limit(1)
        .execute()
    )
    prior = prior_result.data[0] if prior_result.data else None

    await asyncio.to_thread(
        lambda: supabase.table("account_balance_snapshots")
        .insert({"broker_connection_id": connection_id, "balance": balance})
        .execute()
    )

    if prior is None:
        return  # first snapshot ever for this connection — nothing to diff against yet

    raw_drop = prior["balance"] - balance
    if raw_drop < MIN_WITHDRAWAL_AMOUNT:
        return  # balance flat or increased — no withdrawal candidate

    deals = await _get_deal_history_since(connection, prior["synced_at"])
    realized_losses = sum(abs(float(d.get("profit", 0))) for d in deals if float(d.get("profit", 0)) < 0)
    unexplained = raw_drop - realized_losses
    if unexplained < MIN_WITHDRAWAL_AMOUNT:
        return  # the whole drop is explained by trading losses — ordinary drawdown, not a withdrawal

    # A clean signal: no trading activity at all in the window, so there's
    # nothing ambiguous about what caused the drop. Any concurrent trade
    # activity, however small, downgrades to manual confirmation — this
    # heuristic is deliberately conservative (see module docstring).
    confidence = "auto_detected" if not deals else "requires_manual_confirmation"

    event_result = await asyncio.to_thread(
        lambda: supabase.table("withdrawal_events")
        .insert(
            {
                "broker_connection_id": connection_id,
                "user_id": connection["user_id"],
                "detected_amount": unexplained,
                "balance_before": prior["balance"],
                "balance_after": balance,
                "sync_source": "broker_sync_poll",
                "confidence": confidence,
                "status": "pending",
            }
        )
        .execute()
    )
    event = event_result.data[0]
    logger.info(
        "detect_withdrawal_events: withdrawal_event=%s connection=%s amount=%s confidence=%s",
        event["id"],
        connection_id,
        unexplained,
        confidence,
    )

    await _notify_founder(event)

    if confidence == "auto_detected":
        await asyncio.to_thread(
            lambda: supabase.rpc("calculate_payout_split", {"p_withdrawal_event_id": event["id"]}).execute()
        )


async def _get_deal_history_since(connection: dict, since_iso: str) -> list[dict]:
    client = _build_client(connection)
    try:
        return await client.get_history_deals(start_time=since_iso, end_time=datetime.now(UTC).isoformat())
    except Exception:
        logger.exception(
            "detect_withdrawal_events: could not read deal history for connection=%s — treating the window as "
            "having no trade activity, which biases toward requires_manual_confirmation, not auto_detected.",
            connection["id"],
        )
        return []
    finally:
        await client.aclose()


def _build_client(connection: dict) -> MetaTraderClient:
    mt_password = decrypt(connection["encrypted_mt_password"], connection["mt_password_iv"])
    return MetaTraderClient(
        login=connection["mt_login"],
        password=mt_password,
        server=connection["mt_server"],
        platform=connection["mt_platform"],
        metaapi_token=settings.metaapi_token,
        account_id=connection.get("metaapi_account_id"),
        region=connection.get("metaapi_region"),
    )


async def _notify_founder(event: dict) -> None:
    """Founder/ops notification on every new withdrawal_event regardless
    of confidence (spec 3.3) — not gated on confidence the way collection
    decisions are. Calls the Next.js app's own alert route (Slack +
    email), same Python -> Next.js pattern
    decision_gate/step_up_client.py already established for this
    service. Best-effort: a notification failure must never block
    detection from recording the event itself, which already happened
    above."""
    if not settings.app_base_url or not settings.python_service_api_key:
        logger.warning("detect_withdrawal_events: cannot notify founder — VaultPoint API is not configured.")
        return

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{settings.app_base_url}/api/payouts/notify",
                json={"withdrawalEventId": event["id"]},
                headers={"x-api-key": settings.python_service_api_key, "Content-Type": "application/json"},
            )
    except httpx.HTTPError:
        logger.exception("detect_withdrawal_events: founder notification failed for event=%s", event["id"])
