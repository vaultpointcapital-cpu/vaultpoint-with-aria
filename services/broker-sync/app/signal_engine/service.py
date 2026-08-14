"""Signal Engine orchestrator (PRD Sprint 2, component 4B) — the scheduled
job's actual work, wrapped by scheduler.py's score_signals() for the
lock/heartbeat shape every other job in this service uses."""

import asyncio
import logging

from ..config import settings
from ..supabase_client import get_service_client
from .macro_context import build_macro_context
from .scorer import GENERIC_RISK_PROFILE, PROMPT_VERSION, ScoringSkipped, score_candidate

logger = logging.getLogger("broker_sync")


async def score_pending_candidates() -> None:
    if not settings.anthropic_api_key:
        logger.info("score_pending_candidates: ANTHROPIC_API_KEY is not configured — skipping cycle.")
        return

    supabase = get_service_client()

    result = await asyncio.to_thread(
        lambda: supabase.table("candidate_setups").select("*").eq("status", "pending_scoring").execute()
    )
    candidates = result.data or []
    if not candidates:
        return

    macro_context = await build_macro_context()

    for candidate in candidates:
        try:
            await _score_one(supabase, candidate, macro_context)
        except ScoringSkipped as exc:
            # candidate_setups.status stays 'pending_scoring' — picked up
            # again next cycle rather than dropped. Distinct from the
            # generic except below only in log level: this is an expected,
            # recoverable condition (rate limit, transient API error, no
            # key configured), not a bug.
            logger.info("score_pending_candidates: skipping candidate=%s — %s", candidate.get("id"), exc)
        except Exception:
            logger.exception("score_pending_candidates: failed for candidate=%s", candidate.get("id"))


async def _score_one(supabase, candidate: dict, macro_context: dict) -> None:
    result = await score_candidate(candidate, macro_context)

    await asyncio.to_thread(
        lambda: supabase.table("signal_scores")
        .insert(
            {
                "candidate_setup_id": candidate["id"],
                "confidence_score": result.confidence_score,
                "action_class": result.action_class,
                "reasoning": result.reasoning,
                "key_risk_factors": result.key_risk_factors,
                "macro_context": macro_context,
                "account_risk_profile_used": GENERIC_RISK_PROFILE,
                "model": settings.signal_engine_model,
                "prompt_version": PROMPT_VERSION,
                "input_tokens": result.input_tokens,
                "output_tokens": result.output_tokens,
                "latency_ms": result.latency_ms,
            }
        )
        .execute()
    )

    # Flips status only after the signal_scores insert succeeds — if the
    # insert raises (e.g. a unique-violation race with another instance,
    # the Redis scan lock's backstop), this candidate stays
    # 'pending_scoring' and the exception propagates to the per-item
    # except block above rather than silently marking it scored with no
    # score actually recorded.
    await asyncio.to_thread(
        lambda: supabase.table("candidate_setups")
        .update({"status": "scored"})
        .eq("id", candidate["id"])
        .execute()
    )
    logger.info(
        "score_pending_candidates: scored candidate=%s action_class=%s confidence=%s",
        candidate["id"],
        result.action_class,
        result.confidence_score,
    )
