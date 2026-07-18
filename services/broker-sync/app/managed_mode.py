"""Managed Mode: autonomous Signal Mode execution — Aria places trades on
a user's behalf with no per-signal tap, for Elite-tier users who have
explicitly opted a broker connection in (see
supabase/migrations/20260718000002_add_managed_mode.sql).

This is a distinct, higher-risk code path from everything else in this
service: evaluate_managed_mode() is the only function anywhere that
decides to place a trade without a human having just clicked something.
Every safety property either lives here or in the DB CHECK constraint
that gates managed_mode_enabled — there is no third layer, so changes
here deserve the same scrutiny as that migration.

Deliberately narrower than Signal Mode's manual Execute path:
- Only 'elite' tier users act on this — checked fresh every cycle, not
  just at opt-in time, so a downgraded user's connection stops trading
  autonomously on the next cycle rather than silently continuing on
  stale eligibility.
- Only medium/high confidence signals are auto-executed. Low-confidence
  signals still appear in the Signal Mode feed for manual review; this
  scheduler skips them entirely rather than auto-executing a signal
  Aria itself is least sure about.
- Position size is derived fresh each cycle from managed_mode_risk_pct
  and the signal's own stop-loss distance — never a fixed lot/contract
  size a stale scheduler value could freeze at.
- The daily-loss kill switch is checked before every connection's
  signals are evaluated, not just once at startup — a connection that
  breaches it mid-cycle stops before its next signal, not just next
  cycle.
"""

import asyncio
import logging
from datetime import UTC, datetime

from .brokers.bybit import BybitClient
from .brokers.metatrader import MetaTraderClient
from .config import settings
from .encryption import decrypt
from .models import BrokerType
from .signal_execution import SignalExecutionError, execute_signal
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

ELITE_TIER = "elite"
AUTO_EXECUTABLE_CONFIDENCE = {"medium", "high"}


async def evaluate_managed_mode() -> None:
    supabase = get_service_client()

    connections_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections").select("*").eq("managed_mode_enabled", True).execute()
    )

    for connection in connections_result.data or []:
        try:
            await _evaluate_connection(supabase, connection)
        except Exception:
            logger.exception(
                "evaluate_managed_mode: failed for connection=%s", connection.get("id")
            )


async def _evaluate_connection(supabase, connection: dict) -> None:
    connection_id = connection["id"]
    user_id = connection["user_id"]

    profile_result = await asyncio.to_thread(
        lambda: supabase.table("users").select("subscription_tier").eq("id", user_id).maybe_single().execute()
    )
    tier = (profile_result.data or {}).get("subscription_tier")
    if tier != ELITE_TIER:
        logger.warning(
            "Managed Mode connection=%s belongs to a non-Elite user (tier=%s) — disabling.",
            connection_id,
            tier,
        )
        await _disable_managed_mode(supabase, connection_id)
        return

    if await _kill_switch_tripped(supabase, connection):
        logger.warning(
            "Managed Mode daily loss limit breached for connection=%s — disabling.", connection_id
        )
        await _disable_managed_mode(supabase, connection_id)
        return

    signals = await _fetch_eligible_signals(supabase, user_id)
    if not signals:
        return

    client = await _build_client(connection)
    try:
        equity = await client.get_balance()
    except Exception:
        logger.exception(
            "Managed Mode could not read balance for connection=%s — skipping this cycle.",
            connection_id,
        )
        return
    finally:
        await client.aclose()

    for signal in signals:
        await _attempt_execution(supabase, connection, signal, equity)


async def _disable_managed_mode(supabase, connection_id: str) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .update({"managed_mode_enabled": False})
        .eq("id", connection_id)
        .execute()
    )


async def _kill_switch_tripped(supabase, connection: dict) -> bool:
    """Sums today's realized P&L (UTC) across every Aria-initiated,
    executed action on this connection. Two round trips rather than a
    SQL join — matches this module's existing style (see
    alert_engine.py's _get_peak_net_worth/_get_manual_assets) rather than
    introducing an RPC function for what's still a simple read.
    """
    today_start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    actions_result = await asyncio.to_thread(
        lambda: supabase.table("signal_actions")
        .select("id")
        .eq("broker_connection_id", connection["id"])
        .eq("initiated_by", "aria")
        .eq("action", "executed")
        .execute()
    )
    action_ids = [row["id"] for row in actions_result.data or []]
    if not action_ids:
        return False

    outcomes_result = await asyncio.to_thread(
        lambda: supabase.table("signal_outcomes")
        .select("realized_pnl")
        .in_("signal_action_id", action_ids)
        .gte("closed_at", today_start)
        .execute()
    )
    realized_today = sum(row["realized_pnl"] for row in outcomes_result.data or [])
    if realized_today >= 0:
        return False

    # equity used for the % comparison is read fresh here rather than
    # reused from the caller — this function can be called independently
    # of the main position-sizing balance read.
    client = await _build_client(connection)
    try:
        equity = await client.get_balance()
    except Exception:
        logger.exception(
            "Managed Mode kill-switch check could not read balance for connection=%s — "
            "treating as NOT tripped this cycle rather than guessing.",
            connection["id"],
        )
        return False
    finally:
        await client.aclose()

    if equity <= 0:
        return False

    loss_pct = (-realized_today / equity) * 100
    return loss_pct >= connection["managed_mode_daily_loss_limit_pct"]


async def _fetch_eligible_signals(supabase, user_id: str) -> list[dict]:
    signals_result = await asyncio.to_thread(
        lambda: supabase.table("signals")
        .select("*")
        .eq("status", "active")
        .eq("min_tier", ELITE_TIER)
        .execute()
    )
    candidates = [
        s for s in (signals_result.data or []) if s.get("confidence") in AUTO_EXECUTABLE_CONFIDENCE
    ]
    if not candidates:
        return []

    actions_result = await asyncio.to_thread(
        lambda: supabase.table("signal_actions")
        .select("signal_id")
        .eq("user_id", user_id)
        .in_("signal_id", [s["id"] for s in candidates])
        .neq("action", "failed")
        .execute()
    )
    already_acted_on = {row["signal_id"] for row in actions_result.data or []}
    return [s for s in candidates if s["id"] not in already_acted_on]


async def _attempt_execution(supabase, connection: dict, signal: dict, equity: float) -> None:
    signal_id = signal["id"]
    connection_id = connection["id"]
    user_id = connection["user_id"]

    units = _compute_size(connection, signal, equity)
    if units is None:
        return  # invalid stop distance — nothing sane to size, skip rather than guess

    size = await _finalize_size(connection, signal["pair"], units)

    try:
        order_id = await execute_signal(
            user_id=user_id, signal_id=signal_id, broker_connection_id=connection_id, size=size
        )
    except SignalExecutionError as exc:
        # exc's own name is deleted by Python at the end of this except
        # block, so it can't be safely referenced inside the lambda below
        # — captured into a plain local first (same gotcha as
        # main.py's execute_signal_endpoint).
        failure_reason = str(exc)[:500]
        await asyncio.to_thread(
            lambda: supabase.table("signal_actions")
            .insert(
                {
                    "signal_id": signal_id,
                    "user_id": user_id,
                    "broker_connection_id": connection_id,
                    "action": "failed",
                    "executed_size": size,
                    "failure_reason": failure_reason,
                    "initiated_by": "aria",
                }
            )
            .execute()
        )
        logger.warning(
            "Managed Mode execution failed: signal=%s connection=%s reason=%s",
            signal_id,
            connection_id,
            failure_reason,
        )
        return

    await asyncio.to_thread(
        lambda: supabase.table("signal_actions")
        .insert(
            {
                "signal_id": signal_id,
                "user_id": user_id,
                "broker_connection_id": connection_id,
                "action": "executed",
                "executed_size": size,
                "broker_order_id": order_id,
                "initiated_by": "aria",
            }
        )
        .execute()
    )
    logger.info(
        "Managed Mode executed: signal=%s connection=%s order_id=%s size=%s",
        signal_id,
        connection_id,
        order_id,
        size,
    )


def _compute_size(connection: dict, signal: dict, equity: float) -> float | None:
    """Risk-based position sizing: risk_amount / stop_distance, where
    risk_amount is managed_mode_risk_pct of current equity. Result is in
    the instrument's underlying units — correct as-is for Bybit's linear
    contracts, but MetaTrader's place_order expects lots, not units, so
    that conversion happens separately in _finalize_size before this
    value ever reaches execute_signal() for an MT connection. Getting
    this backwards is the classic MT lot/unit sizing bug — a silent
    100x (or 1/100th) order size — so it is handled explicitly, never
    assumed away.
    """
    stop_distance = abs(signal["entry_price"] - signal["stop_loss"])
    if stop_distance <= 0:
        return None

    risk_amount = equity * (connection["managed_mode_risk_pct"] / 100)
    return risk_amount / stop_distance


async def _finalize_size(connection: dict, symbol: str, units: float) -> float:
    """Converts _compute_size's underlying-unit result into whatever
    execute_signal()'s `size` param actually means for this broker.
    Bybit's qty IS underlying units for linear contracts — passed
    through unchanged. MetaTrader's volume is in lots, so this divides
    by the symbol's contract size, using the exact same lookup (and the
    exact same contract_size=1 fallback on a failed specification fetch)
    sync_service.py already uses for position reporting — see
    MetaTraderClient._get_symbol_contract_sizes's own docstring for why
    that fallback is acceptable there; reused here for the same reason
    rather than inventing a stricter failure mode for this one caller.
    """
    if connection["broker"] != BrokerType.METATRADER.value:
        return units

    client = await _build_client(connection)
    try:
        sizes = await client._get_symbol_contract_sizes({symbol})
    finally:
        await client.aclose()

    contract_size = sizes.get(symbol, 1.0)
    return units / contract_size


async def _build_client(connection: dict):
    broker = connection["broker"]
    if broker == BrokerType.BYBIT.value:
        api_key = decrypt(connection["encrypted_api_key"], connection["api_key_iv"])
        api_secret = decrypt(connection["encrypted_api_secret"], connection["api_secret_iv"])
        return BybitClient(api_key, api_secret)

    if broker == BrokerType.METATRADER.value:
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

    raise SignalExecutionError(f"Managed Mode is not supported for broker={broker}.")
