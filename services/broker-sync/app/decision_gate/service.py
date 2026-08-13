"""Decision Gate orchestrator (PRD Sprint 3, component 4C) — the scheduled
job's actual work, wrapped by scheduler.py's evaluate_decision_gate() for
the lock/heartbeat shape every other job in this service uses.

Routes every non-REJECT signal_scores row to every connected MetaTrader
account (broker_connections + managed_sub_accounts) not yet routed for
that signal (idempotency: a decision_gate_log row already existing for
the (signal_score, account) pair means "already handled," checked before
every route so a slow/failed previous attempt is retried, not
duplicated). Only MetaTrader is considered — watchlist_symbols.timeframe
detection is MetaTrader-only today (its own broker CHECK constraint
allows only 'metatrader'); candidate_setups itself carries no broker
column, so this filter is the enforcement point. Revisit if a second
broker is ever added to the watchlist.

Per-account routing:
  - aria_auto_execution_enabled AND action_class == 'AUTO_ELIGIBLE' ->
    auto path (hedging verification -> cool-down -> confidence threshold
    -> sizing sanity, first failure wins, each logged with its own
    specific auto_rejected_* reason).
  - everything else -> manual alert path (step-up + Telegram via the
    Next.js app, plus a durable aria_findings record).
Every outcome is logged to decision_gate_log — nothing is silently
dropped, per the PRD's own "every alert/execution logs confidence score +
reasoning for audit" guardrail.
"""

import asyncio
import logging

from ..config import settings
from ..pantheon.dedup import upsert_finding
from ..supabase_client import get_service_client
from . import cooldown, step_up_client
from .execution_adapter import get_execution_adapter

logger = logging.getLogger("broker_sync")


async def evaluate_decision_gate() -> None:
    supabase = get_service_client()

    scores_result = await asyncio.to_thread(
        lambda: supabase.table("signal_scores").select("*").neq("action_class", "REJECT").execute()
    )
    scores = scores_result.data or []
    if not scores:
        return

    accounts = await _get_target_accounts(supabase)
    if not accounts:
        return

    candidates_by_id = await _get_candidates_by_id(supabase, {s["candidate_setup_id"] for s in scores})

    for score in scores:
        candidate = candidates_by_id.get(score["candidate_setup_id"])
        if candidate is None:
            continue
        for account in accounts:
            try:
                await _route_one(supabase, score, candidate, account)
            except Exception:
                logger.exception(
                    "evaluate_decision_gate: failed routing signal_score=%s account_type=%s account_id=%s",
                    score["id"],
                    account["account_type"],
                    account["id"],
                )


async def _get_target_accounts(supabase) -> list[dict]:
    connections_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .select("*")
        .eq("broker", "metatrader")
        .neq("health", "closed")
        .execute()
    )
    accounts = [
        {**c, "account_type": "broker_connection", "alert_user_id": c["user_id"]}
        for c in (connections_result.data or [])
    ]

    sub_accounts_result = await asyncio.to_thread(
        lambda: supabase.table("managed_sub_accounts").select("*").eq("status", "active").execute()
    )
    sub_accounts = sub_accounts_result.data or []
    if sub_accounts:
        # Two round trips rather than a join — matches this service's
        # existing style (see managed_mode.py's _kill_switch_tripped
        # docstring) for what's still a simple read.
        connection_ids = list({sa["broker_connection_id"] for sa in sub_accounts})
        sub_connections_result = await asyncio.to_thread(
            lambda: supabase.table("broker_connections")
            .select("id, broker, health")
            .in_("id", connection_ids)
            .execute()
        )
        connection_by_id = {c["id"]: c for c in (sub_connections_result.data or [])}
        for sub_account in sub_accounts:
            connection = connection_by_id.get(sub_account["broker_connection_id"])
            if connection is None or connection["broker"] != "metatrader" or connection.get("health") == "closed":
                continue
            accounts.append(
                {**sub_account, "account_type": "managed_sub_account", "alert_user_id": sub_account["client_user_id"]}
            )

    return accounts


async def _get_candidates_by_id(supabase, candidate_ids: set) -> dict:
    if not candidate_ids:
        return {}
    result = await asyncio.to_thread(
        lambda: supabase.table("candidate_setups").select("*").in_("id", list(candidate_ids)).execute()
    )
    return {c["id"]: c for c in (result.data or [])}


async def _already_routed(supabase, signal_score_id: str, account_type: str, account_id: str) -> bool:
    result = await asyncio.to_thread(
        lambda: supabase.table("decision_gate_log")
        .select("id")
        .eq("signal_score_id", signal_score_id)
        .eq("account_type", account_type)
        .eq("account_id", account_id)
        .limit(1)
        .execute()
    )
    return bool(result.data)


async def _route_one(supabase, score: dict, candidate: dict, account: dict) -> None:
    if await _already_routed(supabase, score["id"], account["account_type"], account["id"]):
        return

    if account.get("aria_auto_execution_enabled") and score["action_class"] == "AUTO_ELIGIBLE":
        await _route_auto(supabase, score, candidate, account)
    else:
        await _route_manual(supabase, score, candidate, account)


async def _route_auto(supabase, score: dict, candidate: dict, account: dict) -> None:
    if not account.get("hedging_mode_verified_at"):
        await _log_decision(supabase, score, account, "auto", "auto_rejected_hedging_not_verified")
        return

    if cooldown.is_in_cooldown(account):
        await _log_decision(supabase, score, account, "auto", "auto_rejected_cooldown", cooldown_active=True)
        return

    if score["confidence_score"] < settings.decision_gate_confidence_threshold:
        await _log_decision(supabase, score, account, "auto", "auto_rejected_confidence")
        return

    entry = (candidate["entry_zone_low"] + candidate["entry_zone_high"]) / 2
    stop_distance = abs(entry - candidate["stop_loss"])
    if stop_distance <= 0:
        # Malformed candidate, not an account-side rejection — a sane
        # Scanner detection never produces this, but the gate never
        # trusts that blindly.
        await _log_decision(supabase, score, account, "auto", "auto_rejected_sizing")
        return

    result = await get_execution_adapter().submit(account, candidate, score)
    decision = "auto_approved_executed" if result.status == "executed" else "auto_approved_pending_execution_wiring"
    await _log_decision(supabase, score, account, "auto", decision)


async def _route_manual(supabase, score: dict, candidate: dict, account: dict) -> None:
    try:
        alert_result = await step_up_client.send_manual_alert(
            user_id=account["alert_user_id"], candidate=candidate, score=score, account=account
        )
    except step_up_client.StepUpAlertError:
        # Not logged to decision_gate_log — no row means "not yet routed,"
        # so this (signal_score, account) pair is retried next cycle
        # rather than silently dropped.
        logger.exception(
            "evaluate_decision_gate: manual alert failed for signal_score=%s account_type=%s account_id=%s",
            score["id"],
            account["account_type"],
            account["id"],
        )
        return

    # Durable in-app fallback: the step-up challenge above is the real,
    # time-sensitive channel; this is what lets a user without Telegram
    # linked still see the alert next time they open Aria chat
    # (getNewFindings() has no severity filter). severity is always
    # 'caution', never 'warning'/'critical' — same choice Hermes already
    # makes for its own buy_signal findings, and for the same structural
    # reason: warning/critical is eligible for the proactive-check cron's
    # batched, 5-30-min-latency delivery, the wrong shape and far too slow
    # for this PRD's <30s setup-to-alert latency target. A failure here is
    # logged but not fatal — the step-up challenge already exists and is
    # the channel that actually matters.
    try:
        await upsert_finding(
            supabase,
            user_id=account["alert_user_id"],
            source_agent="aria_scanner",
            finding_type="trade_setup_alert",
            severity="caution",
            asset=candidate["symbol"],
            raw_data={
                "candidateId": candidate["id"],
                "symbol": candidate["symbol"],
                "timeframe": candidate["timeframe"],
                "structureType": candidate["structure_type"],
                "direction": candidate["direction"],
                "entryZoneLow": candidate["entry_zone_low"],
                "entryZoneHigh": candidate["entry_zone_high"],
                "stopLoss": candidate["stop_loss"],
                "takeProfit": candidate["take_profit"],
                "confidenceScore": score["confidence_score"],
                "actionClass": score["action_class"],
                "reasoning": score["reasoning"],
            },
        )
    except Exception:
        logger.exception(
            "evaluate_decision_gate: could not write the durable aria_findings record for signal_score=%s "
            "account_type=%s account_id=%s — the step-up alert itself was still sent.",
            score["id"],
            account["account_type"],
            account["id"],
        )

    await _log_decision(
        supabase,
        score,
        account,
        "manual",
        "alert_sent",
        # The raw step_up_approvals.id (uuid) — NOT alert_result's
        # "approvalId", which is a signed JWT and would fail to cast to
        # this column's uuid type. See src/lib/auth/step-up.ts's
        # InitiateStepUpResult.approvalRowId for why both exist.
        step_up_approval_id=alert_result.get("approvalRowId"),
    )


async def _log_decision(
    supabase,
    score: dict,
    account: dict,
    account_mode: str,
    decision: str,
    *,
    cooldown_active: bool = False,
    step_up_approval_id: str | None = None,
    position_size: float | None = None,
) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("decision_gate_log")
        .insert(
            {
                "signal_score_id": score["id"],
                "account_type": account["account_type"],
                "account_id": account["id"],
                "account_mode": account_mode,
                "decision": decision,
                "confidence_score": score["confidence_score"],
                "reasoning": score["reasoning"],
                "position_size": position_size,
                "cooldown_active": cooldown_active,
                "step_up_approval_id": step_up_approval_id,
            }
        )
        .execute()
    )
    logger.info(
        "decision_gate: signal_score=%s account_type=%s account_id=%s -> %s",
        score["id"],
        account["account_type"],
        account["id"],
        decision,
    )
