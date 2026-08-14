"""HTTP client for the Decision Gate's manual-account alert path (PRD
Sprint 3, component 4C) — calls the Next.js app's
POST /api/aria/scanner/alert, which wraps src/lib/auth/step-up.ts's
initiateStepUp() with a caller-supplied userId.

This is the first Python -> Next.js call anywhere in this service; every
existing cross-service call goes the other direction (Next.js proxies
into this service, e.g. src/app/api/signals/[id]/execute/route.ts ->
POST /signals/{id}/execute). Reuses app_base_url/python_service_api_key
— the same shared secret already sent Next.js -> Python for the opposite
direction — rather than minting a second one.
"""

import httpx

from ..config import settings


class StepUpAlertError(Exception):
    """Raised for any failure sending the manual-account alert. Callers
    must not write a decision_gate_log row when this is raised — the
    (signal_score, account) pair stays unrouted and is retried next
    cycle, same as every other transient-failure-skip in this service."""


async def send_manual_alert(*, user_id: str, candidate: dict, score: dict, account: dict) -> dict:
    if not settings.app_base_url or not settings.python_service_api_key:
        raise StepUpAlertError("VaultPoint API base URL or shared API key is not configured.")

    payload = {
        "userId": user_id,
        "accountType": account["account_type"],
        "accountId": account["id"],
        "candidate": {
            "id": candidate["id"],
            "symbol": candidate["symbol"],
            "timeframe": candidate["timeframe"],
            "structureType": candidate["structure_type"],
            "direction": candidate["direction"],
            "entryZoneLow": candidate["entry_zone_low"],
            "entryZoneHigh": candidate["entry_zone_high"],
            "stopLoss": candidate["stop_loss"],
            "takeProfit": candidate["take_profit"],
        },
        "score": {
            "confidenceScore": score["confidence_score"],
            "actionClass": score["action_class"],
            "reasoning": score["reasoning"],
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{settings.app_base_url}/api/aria/scanner/alert",
                json=payload,
                headers={"x-api-key": settings.python_service_api_key, "Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise StepUpAlertError(f"Could not reach the VaultPoint API: {exc}") from exc

    if response.status_code != 201:
        raise StepUpAlertError(f"Alert route returned {response.status_code}: {response.text[:300]}")

    body = response.json()
    if "approvalRowId" not in body:
        raise StepUpAlertError("Alert route response was missing approvalRowId.")
    return body
