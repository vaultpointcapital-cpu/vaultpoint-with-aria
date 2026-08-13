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
from decimal import Decimal

from .alert_delivery import deliver_alert_email, deliver_alert_in_app
from .config import settings
from .connection_health_notifications import notify_alerts_paused
from .financial import (
    calculate_margin_utilization,
    calculate_net_worth,
    calculate_portfolio_pnl_pct,
    calculate_total_pnl,
)
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

PORTFOLIO_WIDE_TYPES = {"pnl_pct", "pnl_abs", "margin_pct", "drawdown_pct"}

# Connection Health & Data Freshness — same 5-minute staleness threshold
# src/lib/valuation/providers/position-provider.ts uses (STALE_AFTER_MS),
# kept in sync by hand across the two runtimes, same as
# financial.ts/financial.py.
_POSITION_STALE_AFTER_SECONDS = 5 * 60
_ALERTS_PAUSED_AFTER_MINUTES = 15
_HEALTHY_LIKE = {"healthy", "pending"}


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

    # Connection Health & Data Freshness — a portfolio-wide condition
    # (pnl/margin/drawdown) is only as trustworthy as the positions
    # feeding it. A price alert isn't suppressed here: it already only
    # ever evaluates against a specific position's own mark_price (see
    # _resolve_price_value), so a stale position there simply means "no
    # match" via the existing not-found path, not a silently-wrong
    # portfolio-wide aggregate. Connection health is fetched via a
    # separate query (not an embedded positions select) so this doesn't
    # change the positions select's column string — that string is a
    # cache/fixture key elsewhere (this file's own tests, sync_service's
    # Redis cache), and changing it is its own source of drift.
    if condition_type in PORTFOLIO_WIDE_TYPES and await _has_stale_input(supabase, positions):
        await _suppress_alert(supabase, alert)
        return

    if alert.get("stale_notification_sent_at") is not None:
        # This evaluation wasn't suppressed — data has recovered. Clear
        # the one-time "alerts paused" dedup flag so a future stale
        # streak can notify again.
        await asyncio.to_thread(
            lambda: supabase.table("alerts")
            .update({"stale_notification_sent_at": None})
            .eq("id", alert["id"])
            .execute()
        )

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


async def _has_stale_input(supabase, positions: list[dict]) -> bool:
    """True if any position feeding a portfolio-wide condition is stale
    — either its own connection's health says so, or it simply hasn't
    synced in over 5 minutes (covers a connection that's still
    'healthy' from its last successful cycle but hasn't actually run
    one in a while, e.g. mid-backoff)."""
    now = datetime.now(UTC)

    connection_ids = {p["broker_connection_id"] for p in positions if p.get("broker_connection_id")}
    health_by_connection: dict[str, str] = {}
    if connection_ids:
        connections_result = await asyncio.to_thread(
            lambda: supabase.table("broker_connections")
            .select("id, health")
            .in_("id", list(connection_ids))
            .execute()
        )
        health_by_connection = {row["id"]: row.get("health") for row in connections_result.data}

    for p in positions:
        health = health_by_connection.get(p.get("broker_connection_id"))
        if health is not None and health not in _HEALTHY_LIKE:
            return True

        synced_at = p.get("synced_at")
        if synced_at:
            synced = datetime.fromisoformat(synced_at)
            if now - synced > timedelta(seconds=_POSITION_STALE_AFTER_SECONDS):
                return True
    return False


async def _suppress_alert(supabase, alert: dict) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("alert_history")
        .insert(
            {
                "alert_id": alert["id"],
                "user_id": alert["user_id"],
                "triggered_value": 0,
                "message": "Evaluation skipped — underlying portfolio data is stale.",
                "delivered_via": [],
                "suppressed": True,
                "suppressed_reason": "stale_data",
            }
        )
        .execute()
    )
    await _maybe_notify_alerts_paused(supabase, alert)


async def _maybe_notify_alerts_paused(supabase, alert: dict) -> None:
    if alert.get("stale_notification_sent_at") is not None:
        return  # already sent for this suppression streak

    history_result = await asyncio.to_thread(
        lambda: supabase.table("alert_history")
        .select("suppressed, created_at")
        .eq("alert_id", alert["id"])
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )

    streak_start: str | None = None
    for row in history_result.data:
        if not row.get("suppressed"):
            break
        streak_start = row["created_at"]

    if streak_start is None:
        return

    started = datetime.fromisoformat(streak_start)
    if datetime.now(UTC) - started < timedelta(minutes=_ALERTS_PAUSED_AFTER_MINUTES):
        return

    await notify_alerts_paused(alert)
    await asyncio.to_thread(
        lambda: supabase.table("alerts")
        .update({"stale_notification_sent_at": datetime.now(UTC).isoformat()})
        .eq("id", alert["id"])
        .execute()
    )


def _resolve_price_value(symbol: str | None, positions: list[dict]) -> float | None:
    if not symbol:
        return None
    for p in positions:
        if p["symbol"] == symbol and p.get("mark_price") is not None:
            return p["mark_price"]
    return None


def _to_decimal_positions(positions: list[dict]) -> list[dict]:
    """Money & Currency Layer boundary: financial.py's functions require
    Decimal inputs and do no conversion themselves — construct via
    Decimal(str(x)), never Decimal(x) on a float directly (that just
    encodes the float's own imprecision exactly)."""
    converted = []
    for p in positions:
        converted.append(
            {
                **p,
                "size": Decimal(str(p["size"])),
                "entry_price": Decimal(str(p["entry_price"])),
                "mark_price": Decimal(str(p["mark_price"])) if p.get("mark_price") is not None else None,
                "margin_used": Decimal(str(p["margin_used"])) if p.get("margin_used") is not None else None,
            }
        )
    return converted


def _to_decimal_manual_assets(manual_assets: list[dict]) -> list[dict]:
    return [{**a, "value": Decimal(str(a["value"]))} for a in manual_assets]


def _single_currency(positions: list[dict], manual_assets: list[dict]) -> str | None:
    """financial.py deliberately has no Money-style currency-safety wrapper
    (see that module's own docstring) — unlike the TS side, mixing
    currencies here would silently produce a WRONG sum, not throw. Guard
    explicitly: if a user's positions/manual assets span more than one
    currency, skip the alert (return None, same "no data available" path
    as a not-yet-synced position) rather than compute a number that's
    quietly wrong. Full FX-aware alert evaluation (converting each holding
    before aggregating, same as the TS side's portfolio route) is a larger
    follow-up, not attempted here — flagged, not silently done."""
    currencies = {p.get("currency", "USD") for p in positions} | {a.get("currency", "USD") for a in manual_assets}
    if len(currencies) > 1:
        return None
    return currencies.pop() if currencies else "USD"


async def _resolve_portfolio_value(
    supabase, user_id: str, condition_type: str, positions: list[dict]
) -> float | None:
    if condition_type == "pnl_pct":
        return calculate_portfolio_pnl_pct(_to_decimal_positions(positions))

    if condition_type == "pnl_abs":
        return float(calculate_total_pnl(_to_decimal_positions(positions)))

    if condition_type == "margin_pct":
        manual_assets = await _get_manual_assets(supabase, user_id)
        if _single_currency(positions, manual_assets) is None:
            return None
        d_positions = _to_decimal_positions(positions)
        net_worth = calculate_net_worth(d_positions, _to_decimal_manual_assets(manual_assets))
        margin_used = sum((p["margin_used"] for p in d_positions if p["margin_used"] is not None), Decimal(0))
        return calculate_margin_utilization(margin_used, net_worth)

    if condition_type == "drawdown_pct":
        manual_assets = await _get_manual_assets(supabase, user_id)
        if _single_currency(positions, manual_assets) is None:
            return None
        current_net_worth = float(
            calculate_net_worth(_to_decimal_positions(positions), _to_decimal_manual_assets(manual_assets))
        )
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
