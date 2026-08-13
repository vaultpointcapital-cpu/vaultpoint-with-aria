"""Connection Health & Data Freshness — user-facing notifications for a
connection going bad (or recovering). Same direct-Resend-send /
aria_conversations-insert shape as alert_delivery.py, not routed through
any generic dispatcher: no such infrastructure exists in this codebase
yet (see the plan's "Reconciling the spec against what's actually in
this codebase" section) — docs/ecosystem-cohesion/unified-notifications.md
is an analysis doc, not a shipped abstraction.

notify_health_change() is called on EVERY sync attempt, not only when
health actually changes — the 'stale' state's 30-minute grace period and
the recovery notice both need to evaluate elapsed time / prior-
notification state on cycles where health didn't just transition.
Dedup is entirely via broker_connections.notified_health_state: a bad
state notifies once and sets that column; a later recovery only
notifies (and clears it) if it was actually set — so a
degraded->stale->degraded flap never sends more than one notice in
either direction, and 'degraded' itself never notifies at all (not
urgent enough to interrupt the user for — it's still retrying on its
own backoff schedule).
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx

from .config import settings
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

RESEND_API_URL = "https://api.resend.com/emails"
STALE_NOTIFICATION_GRACE_MINUTES = 30

_SUBJECTS = {
    "auth_failed": "Action needed: your broker connection stopped working",
    "stale": "Your broker connection's data may be out of date",
    "closed": "Your broker connection was closed",
}

_MESSAGES = {
    "auth_failed": (
        "VaultPoint could not authenticate with {label} ({broker}). This "
        "usually means the API key/secret was revoked or changed on the "
        "broker's side — reconnect with a fresh key to resume syncing."
    ),
    "stale": (
        "VaultPoint hasn't been able to sync {label} ({broker}) for over "
        "{grace} minutes. Your dashboard may be showing outdated positions "
        "and balances for this connection until it recovers."
    ),
    "closed": (
        "VaultPoint has stopped syncing {label} ({broker}) — the account "
        "appears to be closed or no longer accessible. {reason_note}"
    ),
}

_RECOVERY_SUBJECT = "Your broker connection is back"
_RECOVERY_MESSAGE = "VaultPoint is syncing {label} ({broker}) normally again."


async def notify_health_change(connection: dict, new_health: str) -> None:
    connection_id = connection["id"]
    notified_state = connection.get("notified_health_state")

    if new_health in ("healthy", "pending"):
        if notified_state is not None:
            await _send(connection, _RECOVERY_SUBJECT, _RECOVERY_MESSAGE.format(
                label=connection.get("label", "your connection"), broker=connection.get("broker", "")
            ))
            await _set_notified_state(connection_id, None)
        return

    if new_health in ("auth_failed", "closed"):
        if notified_state != new_health:
            reason_note = (
                "This can't be undone from VaultPoint — remove the connection if you no longer need it."
                if connection.get("closed_reason") == "prop_breached"
                else ""
            )
            message = _MESSAGES[new_health].format(
                label=connection.get("label", "your connection"),
                broker=connection.get("broker", ""),
                reason_note=reason_note,
            )
            await _send(connection, _SUBJECTS[new_health], message)
            await _set_notified_state(connection_id, new_health)
        return

    if new_health == "stale":
        if notified_state == "stale":
            return
        last_success_at = connection.get("last_success_at")
        if last_success_at is None:
            return
        elapsed = datetime.now(UTC) - datetime.fromisoformat(last_success_at)
        if elapsed >= timedelta(minutes=STALE_NOTIFICATION_GRACE_MINUTES):
            message = _MESSAGES["stale"].format(
                label=connection.get("label", "your connection"),
                broker=connection.get("broker", ""),
                grace=STALE_NOTIFICATION_GRACE_MINUTES,
            )
            await _send(connection, _SUBJECTS["stale"], message)
            await _set_notified_state(connection_id, "stale")
        return

    # 'degraded' — deliberately silent, see module docstring.
    return


async def _send(connection: dict, subject: str, message: str) -> None:
    user_id = connection["user_id"]
    supabase = get_service_client()

    user_result = await asyncio.to_thread(
        lambda: supabase.table("users").select("email").eq("id", user_id).single().execute()
    )
    email = user_result.data.get("email") if user_result.data else None

    delivered = False
    if email and settings.resend_api_key and settings.alert_email_from:
        delivered = await _send_email(to_email=email, subject=subject, message=message)
    elif not settings.resend_api_key or not settings.alert_email_from:
        logger.info("Connection health email skipped — RESEND_API_KEY/ALERT_EMAIL_FROM not configured.")

    await _send_in_app(user_id=user_id, message=message)

    logger.info(
        "Connection health notice sent: connection=%s user=%s subject=%r email_delivered=%s",
        connection["id"],
        user_id,
        subject,
        delivered,
    )


async def _send_email(*, to_email: str, subject: str, message: str) -> bool:
    html_body = (
        f"<p>{message}</p>"
        f'<p><a href="{settings.app_base_url}/dashboard/brokers">View your connections in VaultPoint</a></p>'
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": settings.alert_email_from,
                    "to": [to_email],
                    "subject": subject,
                    "html": html_body,
                },
            )
            response.raise_for_status()
        return True
    except Exception:
        logger.exception("Failed to deliver connection health email to %s", to_email)
        return False


async def _send_in_app(*, user_id: str, message: str) -> bool:
    try:
        supabase = get_service_client()
        await asyncio.to_thread(
            lambda: supabase.table("aria_conversations")
            .insert(
                {
                    "user_id": user_id,
                    "channel": "web",
                    "role": "assistant",
                    "content": message,
                    "message_type": "RISK_CHECK",
                }
            )
            .execute()
        )
        return True
    except Exception:
        logger.exception("Failed to deliver in-app connection health notice for user=%s", user_id)
        return False


async def notify_alerts_paused(alert: dict) -> None:
    """Alert Engine — a portfolio-wide alert whose input data has been
    continuously stale for 15+ minutes gets one "alerts paused" notice
    (dedup lives on alerts.stale_notification_sent_at, set by the
    caller). Reuses this module's email/in-app delivery helpers rather
    than the connection-shaped notify_health_change/_send above — an
    alert isn't tied to exactly one connection, so there's no single
    label/broker to report."""
    user_id = alert["user_id"]
    condition_type = alert.get("condition_type", "your")
    message = (
        f"VaultPoint has paused evaluating your {condition_type} alert because the "
        "underlying portfolio data has been out of date for over 15 minutes. It will "
        "resume automatically once your data is fresh again."
    )

    supabase = get_service_client()
    user_result = await asyncio.to_thread(
        lambda: supabase.table("users").select("email").eq("id", user_id).single().execute()
    )
    email = user_result.data.get("email") if user_result.data else None

    if email and settings.resend_api_key and settings.alert_email_from:
        await _send_email(to_email=email, subject="Some of your alerts are paused", message=message)
    await _send_in_app(user_id=user_id, message=message)

    logger.info("Alerts-paused notice sent: alert=%s user=%s", alert.get("id"), user_id)


async def _set_notified_state(connection_id: str, state: str | None) -> None:
    supabase = get_service_client()
    await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .update({"notified_health_state": state})
        .eq("id", connection_id)
        .execute()
    )
