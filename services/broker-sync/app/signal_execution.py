"""Executes a Signal Mode trade. Completely separate code path from
sync_service's poll cycle — never called from there, never scheduled.
Only reachable via POST /signals/{signal_id}/execute in main.py, which
itself requires the same x-api-key auth as /sync/{user_id}.

Every failure path here raises SignalExecutionError specifically so the
caller can distinguish "the order was never placed, safe to record as
failed" from a bug — a bare except swallowing everything into "failed"
would risk misclassifying a real defect as a broker rejection.
"""

import logging

from .brokers.bybit import BybitClient
from .brokers.metatrader import MetaTraderClient
from .config import settings
from .encryption import decrypt
from .models import BrokerType
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

# Deliberately not all four supported brokers — see base.py's docstring.
# Binance/KuCoin execution was never asked for; adding it here would be
# unreviewed scope creep on the highest-risk code in this codebase.
EXECUTABLE_BROKERS = {BrokerType.BYBIT.value, BrokerType.METATRADER.value}


class SignalExecutionError(Exception):
    """The order was NOT placed — callers must record signal_actions
    with action='failed', never 'executed', when this is raised."""


async def execute_signal(*, user_id: str, signal_id: str, broker_connection_id: str, size: float) -> str:
    """Returns the broker's order id on success. Raises
    SignalExecutionError on any failure — validation, decrypt, or the
    broker rejecting the order."""
    supabase = get_service_client()

    connection_result = (
        supabase.table("broker_connections")
        .select("*")
        .eq("id", broker_connection_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    connection = connection_result.data
    if connection is None:
        raise SignalExecutionError("Broker connection not found for this user.")
    if not connection.get("trade_execution_enabled"):
        raise SignalExecutionError(
            "This broker connection is not authorized for trade execution. "
            "Re-authorize it with trade-permission keys first."
        )

    broker = connection["broker"]
    if broker not in EXECUTABLE_BROKERS:
        raise SignalExecutionError(f"Signal Mode execution is not supported for broker={broker}.")

    signal_result = supabase.table("signals").select("*").eq("id", signal_id).maybe_single().execute()
    signal = signal_result.data
    if signal is None:
        raise SignalExecutionError("Signal not found.")
    if signal["status"] != "active":
        raise SignalExecutionError(f"Signal is no longer active (status={signal['status']}).")

    try:
        if broker == BrokerType.BYBIT.value:
            return await _execute_bybit(connection, signal, size, order_link_id=f"sig-{signal_id}"[:36])
        return await _execute_metatrader(connection, signal, size)
    except SignalExecutionError:
        raise
    except Exception as exc:
        logger.exception(
            "Signal execution failed: signal=%s user=%s connection=%s",
            signal_id,
            user_id,
            broker_connection_id,
        )
        raise SignalExecutionError(str(exc)[:500]) from exc


async def _execute_bybit(connection: dict, signal: dict, size: float, order_link_id: str) -> str:
    api_key = decrypt(connection["encrypted_api_key"], connection["api_key_iv"])
    api_secret = decrypt(connection["encrypted_api_secret"], connection["api_secret_iv"])
    client = BybitClient(api_key, api_secret)
    try:
        return await client.place_order(
            symbol=signal["pair"],
            side=signal["direction"],
            qty=size,
            entry_price=signal["entry_price"],
            stop_loss=signal["stop_loss"],
            take_profit=signal["take_profit"],
            order_link_id=order_link_id,
        )
    finally:
        await client.aclose()


async def _execute_metatrader(connection: dict, signal: dict, size: float) -> str:
    if not settings.metaapi_token:
        raise SignalExecutionError("MetaTrader execution is not configured on this server.")
    if not connection.get("metaapi_account_id") or not connection.get("metaapi_region"):
        raise SignalExecutionError(
            "This MetaTrader connection has not completed its first sync yet — try again shortly."
        )

    mt_password = decrypt(connection["encrypted_mt_password"], connection["mt_password_iv"])
    client = MetaTraderClient(
        login=connection["mt_login"],
        password=mt_password,
        server=connection["mt_server"],
        platform=connection["mt_platform"],
        metaapi_token=settings.metaapi_token,
        account_id=connection["metaapi_account_id"],
        region=connection["metaapi_region"],
    )
    try:
        return await client.place_order(
            symbol=signal["pair"],
            side=signal["direction"],
            volume=size,
            entry_price=signal["entry_price"],
            stop_loss=signal["stop_loss"],
            take_profit=signal["take_profit"],
        )
    finally:
        await client.aclose()
