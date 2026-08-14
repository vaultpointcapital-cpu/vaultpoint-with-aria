"""Signal Engine — scores one candidate_setups row via Claude, exactly
once (PRD Sprint 2, component 4B). Never called per-candle; only ever
called by signal_engine/service.py's score_pending_candidates() against a
row the Scanner has already produced deterministically.

signal_scores is a GLOBAL table (unique on candidate_setup_id, not
per-account) — scoring reflects "is this setup itself any good," using
the platform's standard 2-5% risk cap as generic sizing context, not any
individual account's numbers. Per-account eligibility (does THIS account's
confidence threshold/cooldown/sizing allow acting on it) is the Decision
Gate's job (app/decision_gate/), not this module's.
"""

import logging
import time

import anthropic

from ..config import settings

logger = logging.getLogger("broker_sync")

PROMPT_VERSION = "v1"

# Bounds mirrored from the Managed Mode / Decision Gate risk-sizing rule
# (managed_mode_risk_pct is capped 0-5% at the DB level, see
# supabase/migrations/20260718000002_add_managed_mode.sql) — passed as
# generic context so the model's AUTO_ELIGIBLE judgment already accounts
# for realistic position sizing, not just direction/structure quality.
GENERIC_RISK_PROFILE = {"min_risk_pct_per_trade": 2, "max_risk_pct_per_trade": 5}

SCORE_SIGNAL_TOOL = {
    "name": "submit_signal_score",
    "description": "Submit the confidence score and routing decision for this candidate SMC trade setup.",
    "input_schema": {
        "type": "object",
        "properties": {
            "confidence_score": {
                "type": "number",
                "description": (
                    "0-100. How strong this setup is, given the detected structure, macro "
                    "context, and risk profile."
                ),
            },
            "action_class": {
                "type": "string",
                "enum": ["ALERT_ONLY", "AUTO_ELIGIBLE", "REJECT"],
                "description": (
                    "REJECT: not a real/tradeable setup. ALERT_ONLY: valid but not confident enough, or "
                    "conditions unsuitable, for unattended auto-execution — surface to the user instead. "
                    "AUTO_ELIGIBLE: confident and clean enough to be eligible for auto-execution, subject "
                    "to the Decision Gate's own per-account guardrails."
                ),
            },
            "reasoning": {
                "type": "string",
                "description": "2-4 sentences citing the specific SMC structure and macro factors behind the score.",
            },
            "key_risk_factors": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Short bullet-style risk factors a trader should weigh "
                    "(e.g. 'tight stop relative to recent volatility')."
                ),
            },
        },
        "required": ["confidence_score", "action_class", "reasoning", "key_risk_factors"],
    },
}


class ScoringResult:
    def __init__(
        self,
        *,
        confidence_score,
        action_class,
        reasoning,
        key_risk_factors,
        input_tokens,
        output_tokens,
        latency_ms,
    ):
        self.confidence_score = confidence_score
        self.action_class = action_class
        self.reasoning = reasoning
        self.key_risk_factors = key_risk_factors
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.latency_ms = latency_ms


class ScoringSkipped(Exception):
    """Raised for a failure the caller should treat as 'retry next cycle,'
    never as 'this candidate is bad' — service.py catches this and leaves
    candidate_setups.status untouched rather than marking it scored."""


def build_scoring_prompt(candidate: dict, macro_context: dict) -> str:
    return f"""You are Aria, VaultPoint's AI trading advisor, scoring a candidate SMC (Smart Money Concepts) \
trade setup detected by the deterministic Scanner Service. You did not detect this setup yourself — evaluate \
whether it is actually worth acting on.

Candidate setup (JSON):
{candidate}

Macro context (JSON, may be empty if no feed is currently configured):
{macro_context}

Standard account risk parameters (JSON) — position sizing on any account that acts on this setup will be \
bounded by these regardless of your score, so weigh whether the setup's risk:reward still makes sense within them:
{GENERIC_RISK_PROFILE}

Hard rules:
- You are not a licensed financial advisor. Score based on setup quality, not a guarantee of outcome.
- REJECT anything that isn't a genuinely clean, tradeable setup — a marginal detection from the rules engine \
is not automatically a good trade.
- AUTO_ELIGIBLE is reserved for setups clean and confident enough that a Decision Gate could reasonably let an \
opted-in account act on them unattended — be conservative here, not optimistic.
- Never guarantee returns in your reasoning.

Call submit_signal_score with your evaluation."""


async def score_candidate(candidate: dict, macro_context: dict) -> ScoringResult:
    if not settings.anthropic_api_key:
        raise ScoringSkipped("ANTHROPIC_API_KEY is not configured.")

    prompt = build_scoring_prompt(candidate, macro_context)

    started_at = time.monotonic()
    try:
        async with anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key) as client:
            response = await client.messages.create(
                model=settings.signal_engine_model,
                max_tokens=settings.signal_engine_max_tokens,
                tools=[SCORE_SIGNAL_TOOL],
                tool_choice={"type": "tool", "name": "submit_signal_score"},
                messages=[{"role": "user", "content": prompt}],
            )
    except anthropic.RateLimitError as exc:
        raise ScoringSkipped(f"Rate limited — will retry next cycle: {exc}") from exc
    except anthropic.APIConnectionError as exc:
        raise ScoringSkipped(f"Could not reach Anthropic — will retry next cycle: {exc}") from exc
    except anthropic.APIStatusError as exc:
        # A non-retryable 4xx (bad request, auth) would fail identically
        # every cycle if treated as skip-and-retry-forever — but there is
        # no safe alternative action for a batch job with no user to
        # surface an error to, so this still degrades to "retry next
        # cycle, logged loudly" rather than silently dropping the
        # candidate. An operator watching Sentry is the actual mitigation.
        logger.exception("signal_engine.scorer: Anthropic API error (status=%s)", exc.status_code)
        raise ScoringSkipped(f"Anthropic API error: {exc}") from exc

    latency_ms = int((time.monotonic() - started_at) * 1000)

    tool_use_blocks = [block for block in response.content if block.type == "tool_use"]
    if not tool_use_blocks:
        raise ScoringSkipped("Anthropic response contained no tool_use block despite forced tool_choice.")

    tool_input = tool_use_blocks[0].input

    return ScoringResult(
        confidence_score=float(tool_input["confidence_score"]),
        action_class=tool_input["action_class"],
        reasoning=tool_input["reasoning"],
        key_risk_factors=tool_input["key_risk_factors"],
        input_tokens=response.usage.input_tokens if response.usage else None,
        output_tokens=response.usage.output_tokens if response.usage else None,
        latency_ms=latency_ms,
    )
