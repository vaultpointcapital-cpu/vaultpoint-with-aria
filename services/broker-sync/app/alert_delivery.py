"""Delivers a fired alert via its configured channels: email (Resend) and
in-app (aria_conversations). Browser push and Telegram are explicitly out
of scope for this pass — see the Alert Engine spec's "what not to do".

in-app delivery targets public.aria_conversations, defined in
supabase/migrations/20260717000004_add_aria_conversations.sql — that
migration has not been applied to any database yet (local, shadow, or
live), so this function is correct against the schema but untested
against a real one. It's written defensively (never raises past itself)
so a missing table doesn't take down alert evaluation once it lands.
"""

import logging

import httpx

from .config import settings
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

RESEND_API_URL = "https://api.resend.com/emails"


async def deliver_alert_email(*, to_email: str, subject: str, message: str, app_url: str) -> bool:
    """Simple factual template — not Aria's persona voice, per spec:
    what triggered, current value, link back to the app. Returns False
    (never raises) on any failure so a delivery problem doesn't abort
    alert evaluation for other alerts/users in the same cycle."""
    if not settings.resend_api_key or not settings.alert_email_from:
        logger.info("Email delivery skipped — RESEND_API_KEY/ALERT_EMAIL_FROM not configured.")
        return False

    html_body = (
        f"<p>{message}</p>"
        f'<p><a href="{app_url}">View in VaultPoint</a></p>'
        "<p style=\"color:#666;font-size:12px\">You're receiving this because you set up an alert in VaultPoint.</p>"
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
        logger.exception("Failed to deliver alert email to %s", to_email)
        return False


async def deliver_alert_in_app(*, user_id: str, message: str, message_type: str) -> bool:
    """Inserts a row into aria_conversations so the (separately-built)
    Aria widget can surface it with an unread badge — see the Aria
    in-app workstream. role is always 'assistant': this is Aria speaking
    to the user, not the user's own message."""
    try:
        supabase = get_service_client()
        supabase.table("aria_conversations").insert(
            {
                "user_id": user_id,
                "channel": "web",
                "role": "assistant",
                "content": message,
                "message_type": message_type,
            }
        ).execute()
        return True
    except Exception:
        logger.exception("Failed to deliver in-app alert for user=%s", user_id)
        return False
