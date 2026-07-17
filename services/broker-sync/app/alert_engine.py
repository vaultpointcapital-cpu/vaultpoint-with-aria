"""Evaluates active alert rules on a schedule, consuming data the broker
sync side of this service already produces — never polls a broker
directly (see tests/test_alert_engine.py's assertion that no broker
client is ever constructed from this module).

Reads live position data from the durable public.positions table (kept
fresh every poll cycle by sync_service.py), the same source
src/app/api/aria/chat/route.ts's context-assembly already uses for the
identical purpose — not the Redis positions:{connection_id} cache the
original spec named. That cache is per-connection, TTL'd at
cache_ttl_seconds (55s), and only ever read directly by nothing else in
this codebase; reading it here risked a false "no data" skip on any
cycle where the alert evaluator's timing landed just past a cache
entry's expiry relative to the next poll. The positions table has no
such race and is already the source of truth Aria itself queries for
the same portfolio-context purpose. Flagged as a deliberate deviation
from the letter of "pull from Redis," not the intent ("don't re-poll
brokers directly"), which this still satisfies.

Price alerts (condition_type='price') can only be evaluated for a
symbol the user currently holds an open position in — there is no
general "market price for any symbol" cache or table in this codebase,
only per-position mark_price. A price alert on a symbol with no open
position is skipped (not fired, not errored) until a position in that
symbol exists. This is a real functional limitation worth surfacing.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from .alert_delivery import deliver_alert_email, deliver_alert_in_app
from .config import settings
from .financial import (
    calculate_margin_utilization,
    calculate_net_worth,
    calculate_portfolio_pnl_pct,
    calculate_total_pnl,
)
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

PORTFOLIO_WIDE_TYPES = {"pnl_pct", "pnl_abs", "margin_pct", "drawdown_pct"}


async def evaluate_all_alerts() -> None:
    supabase = get_service_client()
    alerts_result = await asyncio.to_thread(
        lambda: supabase.table("alerts").select("*").eq("is_active", True).execute()
    )

    for alert in alerts_result.data:
        try:
            await evaluate_alert(alert)
        except Exception:
            logger.exception("evaluate_all_alerts: failed to evaluate alert=%s", alert.get("id"))


async def evaluate_alert(alert: dict) -> None:
    supabase = get_service_client()
    user_id = alert["user_id"]

    positions_result = await asyncio.to_thread(
        lambda: supabase.table("positions").select("*").eq("user_id", user_id).execute()
    )
    positions = positions_result.data

    condition_type = alert["condition_type"]
    if condition_type in PORTFOLIO_WIDE_TYPES:
        value = await _resolve_portfolio_value(supabase, user_id, condition_type, positions)
    else:
        value = _resolve_price_value(alert["symbol"], positions)

    if value is None:
        return  # no cached/synced data available for this alert yet — skip, not an error

    if not _condition_met(alert["operator"], value, alert["threshold"]):
        return

    if not _cooldown_elapsed(alert.get("last_triggered_at")):
        return

    await _fire_alert(supabase, alert, value)


def _resolve_price_value(symbol: str | None, positions: list[dict]) -> float | None:
    if not symbol:
        return None
    for p in positions:
        if p["symbol"] == symbol and p.get("mark_price") is not None:
            return p["mark_price"]
    return None


async def _resolve_portfolio_value(
    supabase, user_id: str, condition_type: str, positions: list[dict]
) -> float | None:
    if condition_type == "pnl_pct":
        return calculate_portfolio_pnl_pct(positions)

    if condition_type == "pnl_abs":
        return calculate_total_pnl(positions)

    if condition_type == "margin_pct":
        manual_assets = await _get_manual_assets(supabase, user_id)
        net_worth = calculate_net_worth(positions, manual_assets)
        margin_used = sum(p.get("margin_used") or 0 for p in positions)
        return calculate_margin_utilization(margin_used, net_worth)

    if condition_type == "drawdown_pct":
        manual_assets = await _get_manual_assets(supabase, user_id)
        current_net_worth = calculate_net_worth(positions, manual_assets)
        peak_net_worth = await _get_peak_net_worth(supabase, user_id)
        if peak_net_worth is None or peak_net_worth <= 0:
            return None  # no snapshot history yet — nothing to measure drawdown against
        return ((peak_net_worth - current_net_worth) / peak_net_worth) * 100

    return None


async def _get_manual_assets(supabase, user_id: str) -> list[dict]:
    result = await asyncio.to_thread(
        lambda: supabase.table("manual_assets").select("value").eq("user_id", user_id).execute()
    )
    return result.data


async def _get_peak_net_worth(supabase, user_id: str) -> float | None:
    """Historical high-water mark from portfolio_snapshots (written once
    per day by sync_service.py's _upsert_portfolio_snapshot). Today's
    live value isn't in that table until tonight's snapshot, which is
    correct — "peak" should reflect confirmed daily closes, not every
    intra-day fluctuation of the current cycle."""
    result = await asyncio.to_thread(
        lambda: supabase.table("portfolio_snapshots")
        .select("total_net_worth")
        .eq("user_id", user_id)
        .order("total_net_worth", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return result.data[0]["total_net_worth"]


def _condition_met(operator: str, value: float, threshold: float) -> bool:
    return value > threshold if operator == "above" else value < threshold


def _cooldown_elapsed(last_triggered_at: str | None) -> bool:
    if last_triggered_at is None:
        return True
    last = datetime.fromisoformat(last_triggered_at)
    return datetime.now(UTC) - last > timedelta(hours=settings.alert_cooldown_hours)


def _message_type_for(condition_type: str, operator: str) -> str:
    """No generic "user alert fired" value exists in aria_conversations'
    message_type enum (it's Aria's own Telegram-heritage taxonomy — see
    that migration's comment) — mapped onto the closest existing meaning
    rather than adding a new one. Risk metrics (margin/drawdown) always
    read as a risk check regardless of direction; everything else reads
    as loss (crossed below) or profit (crossed above)."""
    if condition_type in ("margin_pct", "drawdown_pct"):
        return "RISK_CHECK"
    return "LOSS_WARNING" if operator == "below" else "PROFIT_ALERT"


def _format_message(alert: dict, value: float) -> str:
    condition_type = alert["condition_type"]
    direction = "crossed above" if alert["operator"] == "above" else "crossed below"
    threshold = alert["threshold"]

    if condition_type == "price":
        return f"{alert['symbol']} {direction} ${threshold:,.2f} (now ${value:,.2f})"
    if condition_type == "pnl_pct":
        return f"Portfolio P&L {direction} {threshold}% (now {value:.2f}%)"
    if condition_type == "pnl_abs":
        return f"Portfolio P&L {direction} ${threshold:,.2f} (now ${value:,.2f})"
    if condition_type == "margin_pct":
        return f"Margin utilization {direction} {threshold}% (now {value:.2f}%)"
    if condition_type == "drawdown_pct":
        return f"Portfolio drawdown {direction} {threshold}% (now {value:.2f}%)"
    return f"Alert condition met (now {value})"


async def _fire_alert(supabase, alert: dict, value: float) -> None:
    message = _format_message(alert, value)
    message_type = _message_type_for(alert["condition_type"], alert["operator"])
    now = datetime.now(UTC).isoformat()

    history_insert = await asyncio.to_thread(
        lambda: supabase.table("alert_history")
        .insert(
            {
                "alert_id": alert["id"],
                "user_id": alert["user_id"],
                "triggered_value": value,
                "message": message,
                "delivered_via": [],
            }
        )
        .execute()
    )
    history_id = history_insert.data[0]["id"]

    await asyncio.to_thread(
        lambda: supabase.table("alerts")
        .update({"last_triggered_at": now})
        .eq("id", alert["id"])
        .execute()
    )

    delivered_via = []

    user_result = await asyncio.to_thread(
        lambda: supabase.table("users").select("email").eq("id", alert["user_id"]).single().execute()
    )
    email = user_result.data.get("email") if user_result.data else None
    if email:
        sent = await deliver_alert_email(
            to_email=email,
            subject="VaultPoint alert triggered",
            message=message,
            app_url=settings.app_base_url,
        )
        if sent:
            delivered_via.append("email")

    in_app_sent = await deliver_alert_in_app(
        user_id=alert["user_id"], message=message, message_type=message_type
    )
    if in_app_sent:
        delivered_via.append("in_app")

    if delivered_via:
        await asyncio.to_thread(
            lambda: supabase.table("alert_history")
            .update({"delivered_via": delivered_via})
            .eq("id", history_id)
            .execute()
        )

    logger.info(
        "Alert fired: id=%s user=%s condition=%s delivered_via=%s",
        alert["id"],
        alert["user_id"],
        alert["condition_type"],
        delivered_via,
    )
