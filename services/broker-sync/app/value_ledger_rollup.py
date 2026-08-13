"""Value Ledger — nightly per-user rollup (PRD "Value Realization &
Business Health Monitoring Infrastructure", Phase 1 foundation + Phase 2
surfacing).

Computes value_score / value_to_price_ratio / churn_risk_score per §5/§6
of the PRD and upserts one row per (user, day) into value_ledger_rollups
(supabase/migrations/20260815000000_add_value_ledger.sql) — a plain
table, not a materialized view (none exist in this codebase; this follows
portfolio_snapshots' precedent instead). Also narrates notable numbers
into Aria via the existing Pantheon write path (app/pantheon/dedup.py).

Entry point: compute_rollups(), wrapped by scheduler.py's
run_value_ledger_rollup() with the standard lock/heartbeat shape.
"""

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta

from .pantheon.dedup import upsert_finding
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

WINDOW_DAYS = 30
ALERT_ACTED_ON_WINDOW_MINUTES = 15
CHURN_TOTAL_WEIGHT = 13  # 3+3+3+2+2 — support-ticket signal omitted, no such table exists
TIER_PRICE_NORMALIZED = {"free": None, "pro": 1.0, "elite": 2.75}  # ratio of TIER_AMOUNT_NGN {pro: 20000, elite: 55000}


async def compute_rollups() -> None:
    supabase = get_service_client()
    today = datetime.now(UTC).date()

    users_result = await asyncio.to_thread(
        lambda: supabase.table("users").select("id, subscription_tier, created_at, academy_student").execute()
    )
    last_sign_in_by_user = await _get_last_sign_in_map(supabase)

    for user in users_result.data:
        try:
            await _compute_and_upsert_for_user(supabase, user, today, last_sign_in_by_user.get(user["id"]))
        except Exception:
            logger.exception("value_ledger_rollup: failed for user=%s", user["id"])


async def _get_last_sign_in_map(supabase) -> dict[str, datetime | None]:
    """auth.users.last_sign_in_at isn't exposed on public.users — reached
    via the admin API, same access pattern
    src/app/api/aria/pantheon/proactive-check/route.ts uses on the TS side
    (getUserById), paginated here since list_users() caps page size."""
    result: dict[str, datetime | None] = {}
    page = 1
    per_page = 200
    while True:
        response = await asyncio.to_thread(
            lambda p=page: supabase.auth.admin.list_users(page=p, per_page=per_page)
        )
        users = response if isinstance(response, list) else getattr(response, "users", [])
        if not users:
            break
        for u in users:
            last_sign_in = getattr(u, "last_sign_in_at", None)
            if isinstance(last_sign_in, str):
                result[u.id] = datetime.fromisoformat(last_sign_in.replace("Z", "+00:00"))
            else:
                result[u.id] = last_sign_in
        if len(users) < per_page:
            break
        page += 1
    return result


async def _compute_and_upsert_for_user(
    supabase, user: dict, today: date, last_sign_in_at: datetime | None
) -> None:
    user_id = user["id"]
    tier = user["subscription_tier"]
    window_start = (datetime.now(UTC) - timedelta(days=WINDOW_DAYS)).isoformat()

    winrate, aria_count = await _compute_aria_attribution(supabase, user_id, window_start)
    pod_goal_hits, pod_pace_delta, active_pods = await _compute_pod_signals(supabase, user_id, window_start, today)
    alerts_fired, alerts_acted_on, alert_pnl_saved = await _compute_alert_signals(supabase, user_id, window_start)
    time_to_first_value = await _compute_time_to_first_value(supabase, user_id, user["created_at"])
    feature_adoption = await _compute_feature_adoption(supabase, user_id)
    net_return, fee_ratio = await _compute_managed_account_signals(supabase, user_id, window_start)

    value_score = _compute_value_score(
        active_pods=active_pods,
        alerts_fired=alerts_fired,
        alerts_acted_on=alerts_acted_on,
        aria_winrate=winrate,
        aria_count=aria_count,
        time_to_first_value_days=time_to_first_value,
        feature_adoption_rate=feature_adoption,
    )

    tier_price_normalized = TIER_PRICE_NORMALIZED.get(tier)
    value_to_price_ratio = (value_score / 100) / tier_price_normalized if tier_price_normalized else None

    churn_score, churn_level, churn_reasons = await _compute_churn_risk(
        supabase,
        user_id=user_id,
        tier=tier,
        last_sign_in_at=last_sign_in_at,
        value_to_price_ratio=value_to_price_ratio,
        alerts_fired=alerts_fired,
        alerts_acted_on=alerts_acted_on,
    )

    upsell_candidate = await _is_upsell_candidate(supabase, user_id, tier, value_score)

    row = {
        "user_id": user_id,
        "rollup_date": str(today),
        "subscription_tier": tier,
        "pod_goal_hits_30d": pod_goal_hits,
        "pod_pace_delta_pct": pod_pace_delta,
        "alerts_fired_30d": alerts_fired,
        "alerts_acted_on_30d": alerts_acted_on,
        "alert_pnl_saved_30d": alert_pnl_saved,
        "aria_recommendation_winrate_30d": winrate,
        "aria_recommendation_count_30d": aria_count,
        "time_to_first_value_days": time_to_first_value,
        "feature_adoption_rate": feature_adoption,
        "value_score": value_score,
        "tier_price_normalized": tier_price_normalized,
        "value_to_price_ratio": value_to_price_ratio,
        "churn_risk_score": churn_score,
        "churn_risk_level": churn_level,
        "churn_risk_reasons": churn_reasons,
        "upsell_candidate": upsell_candidate,
        "managed_account_net_return_30d": net_return,
        "fee_to_return_ratio_30d": fee_ratio,
    }

    await asyncio.to_thread(
        lambda: supabase.table("value_ledger_rollups").upsert(row, on_conflict="user_id,rollup_date").execute()
    )

    await _maybe_narrate_to_aria(supabase, user_id, today, pod_pace_delta, alerts_fired, alerts_acted_on)


# ============================================================================
# Component computations
# ============================================================================

async def _compute_aria_attribution(supabase, user_id: str, window_start: str) -> tuple[float | None, int]:
    """Python-native equivalent of src/lib/billing/profit-share.ts's
    computeAttributedProfit — same two-step join (signal_actions ->
    signal_outcomes), deliberately duplicated rather than wrapped in a new
    RPC (see plan §5 item 1)."""
    actions_result = await asyncio.to_thread(
        lambda: supabase.table("signal_actions")
        .select("id")
        .eq("user_id", user_id)
        .eq("initiated_by", "aria")
        .eq("action", "executed")
        .execute()
    )
    action_ids = [a["id"] for a in actions_result.data]
    if not action_ids:
        return None, 0

    outcomes_result = await asyncio.to_thread(
        lambda: supabase.table("signal_outcomes")
        .select("result, realized_pnl")
        .in_("signal_action_id", action_ids)
        .gte("closed_at", window_start)
        .execute()
    )
    outcomes = outcomes_result.data
    if not outcomes:
        return None, 0

    wins = sum(1 for o in outcomes if o["result"] == "win")
    losses = sum(1 for o in outcomes if o["result"] == "loss")
    breakeven = sum(1 for o in outcomes if o["result"] == "breakeven")
    total = wins + losses + breakeven
    winrate = (wins + 0.5 * breakeven) / total if total else None
    return winrate, total


async def _compute_pod_signals(
    supabase, user_id: str, window_start: str, today: date
) -> tuple[int, float | None, list[dict]]:
    events_result = await asyncio.to_thread(
        lambda: supabase.table("value_ledger_events")
        .select("id")
        .eq("user_id", user_id)
        .eq("event_name", "pod_goal_hit")
        .gte("created_at", window_start)
        .execute()
    )
    pod_goal_hits = len(events_result.data)

    pods_result = await asyncio.to_thread(
        lambda: supabase.table("savings_pods")
        .select("current_amount, target_amount, deadline, created_at")
        .eq("user_id", user_id)
        .eq("status", "active")
        .execute()
    )
    active_pods = pods_result.data

    deltas: list[float] = []
    for pod in active_pods:
        if not pod.get("deadline") or not pod.get("target_amount"):
            continue
        created = datetime.fromisoformat(pod["created_at"].replace("Z", "+00:00")).date()
        deadline = date.fromisoformat(pod["deadline"])
        total_days = (deadline - created).days
        if total_days <= 0:
            continue
        elapsed_days = (today - created).days
        expected_fraction = max(0.0, min(1.0, elapsed_days / total_days))
        actual_fraction = float(pod["current_amount"]) / float(pod["target_amount"]) if pod["target_amount"] else 0.0
        deltas.append((actual_fraction - expected_fraction) * 100)

    pace_delta = sum(deltas) / len(deltas) if deltas else None
    return pod_goal_hits, pace_delta, active_pods


async def _compute_alert_signals(supabase, user_id: str, window_start: str) -> tuple[int, int, float | None]:
    """alert_acted_on is a v1 heuristic, not backtested — a
    position_closed value_ledger event within 15 minutes of an alert
    firing counts as "acted on".

    alert_pnl_saved is NOT computed this pass and always returns None,
    deliberately — a real $-impact estimate needs a price-at-alert-time
    vs. price-at-action-time comparison, and this service has no
    price-history/mark-price-at-a-past-timestamp lookup for arbitrary
    symbols (alert_history.triggered_value isn't even always a price —
    it's whatever the alert's condition_type is, e.g. pnl_pct/pnl_abs/
    margin_pct, not necessarily 'price'). Fabricating a number here would
    be worse than leaving it null — same "don't invent figures we don't
    have" stance as src/lib/wallet/limits.ts's placeholder comment. Wiring
    a real estimate needs a price-history data source that doesn't exist
    in this codebase yet.
    """
    alerts_result = await asyncio.to_thread(
        lambda: supabase.table("alert_history")
        .select("id, alert_id, created_at")
        .eq("user_id", user_id)
        .gte("created_at", window_start)
        .execute()
    )
    fired = alerts_result.data
    if not fired:
        return 0, 0, None

    closes_result = await asyncio.to_thread(
        lambda: supabase.table("value_ledger_events")
        .select("created_at")
        .eq("user_id", user_id)
        .eq("event_name", "position_closed")
        .gte("created_at", window_start)
        .execute()
    )
    closes = closes_result.data

    acted_on = 0
    for alert in fired:
        alert_time = datetime.fromisoformat(alert["created_at"].replace("Z", "+00:00"))
        window_end = alert_time + timedelta(minutes=ALERT_ACTED_ON_WINDOW_MINUTES)
        match = next(
            (
                c
                for c in closes
                if alert_time <= datetime.fromisoformat(c["created_at"].replace("Z", "+00:00")) <= window_end
            ),
            None,
        )
        if match is not None:
            acted_on += 1

    return len(fired), acted_on, None


async def _compute_time_to_first_value(supabase, user_id: str, user_created_at: str) -> int | None:
    created = datetime.fromisoformat(user_created_at.replace("Z", "+00:00"))
    candidates: list[datetime] = []

    for event_name in ("pod_goal_hit", "wallet_deposit", "kyc_tier_upgraded"):
        result = await asyncio.to_thread(
            lambda name=event_name: supabase.table("value_ledger_events")
            .select("created_at")
            .eq("user_id", user_id)
            .eq("event_name", name)
            .order("created_at")
            .limit(1)
            .execute()
        )
        if result.data:
            candidates.append(datetime.fromisoformat(result.data[0]["created_at"].replace("Z", "+00:00")))

    broker_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .select("created_at")
        .eq("user_id", user_id)
        .order("created_at")
        .limit(1)
        .execute()
    )
    if broker_result.data:
        candidates.append(datetime.fromisoformat(broker_result.data[0]["created_at"].replace("Z", "+00:00")))

    if not candidates:
        return None
    return max(0, (min(candidates) - created).days)


async def _compute_feature_adoption(supabase, user_id: str) -> float:
    """Fixed 5-item checklist, hand-picked for this pass — not PRD-specified.
    Swaps the plan's original 'viewed markets page' idea for 'made a wallet
    deposit', since no usage_events writer exists anywhere yet
    (src/lib/analytics/track.ts has zero call sites currently) and this
    substitutes a check with real, live data today."""
    checks = [
        ("savings_pods", "user_id"),
        ("broker_connections", "user_id"),
        ("aria_conversations", "user_id"),
    ]
    hits = 0
    total = 5

    for table, col in checks:
        result = await asyncio.to_thread(
            lambda t=table, c=col: supabase.table(t).select("id").eq(c, user_id).limit(1).execute()
        )
        if result.data:
            hits += 1

    active_alert_result = await asyncio.to_thread(
        lambda: supabase.table("alerts").select("id").eq("user_id", user_id).eq("is_active", True).limit(1).execute()
    )
    if active_alert_result.data:
        hits += 1

    deposit_result = await asyncio.to_thread(
        lambda: supabase.table("wallet_transactions")
        .select("id")
        .eq("user_id", user_id)
        .eq("type", "deposit")
        .eq("status", "completed")
        .limit(1)
        .execute()
    )
    if deposit_result.data:
        hits += 1

    return hits / total


async def _compute_managed_account_signals(
    supabase, user_id: str, window_start: str
) -> tuple[float | None, float | None]:
    """Informational only — not part of value_score/churn_risk_score.
    Mirrors computeDistributionBreakdown's simple (non-drawdown-aware)
    branch in src/lib/validations/managed-accounts.ts."""
    accounts_result = await asyncio.to_thread(
        lambda: supabase.table("managed_accounts").select("id, tier").eq("user_id", user_id).execute()
    )
    accounts = accounts_result.data
    if not accounts:
        return None, None

    profit_split_by_tier = {"bronze": 30, "silver": 25, "gold": 20}

    total_net_return = 0.0
    total_fee = 0.0
    total_gross = 0.0
    any_account = False

    for account in accounts:
        trades_result = await asyncio.to_thread(
            lambda acc_id=account["id"]: supabase.table("managed_trades")
            .select("realized_pnl, closed_at")
            .eq("managed_account_id", acc_id)
            .gte("closed_at", window_start)
            .execute()
        )
        gross = sum(float(t["realized_pnl"]) for t in trades_result.data if t.get("realized_pnl") is not None)
        if not trades_result.data:
            continue
        any_account = True
        profit_split_pct = profit_split_by_tier.get(account["tier"], 30)
        fee = gross * (profit_split_pct / 100) if gross > 0 else 0.0
        total_net_return += gross - fee
        total_fee += fee
        total_gross += gross

    if not any_account:
        return None, None

    fee_ratio = total_fee / total_gross if total_gross > 0 else None
    return total_net_return, fee_ratio


# ============================================================================
# Composite scores (PRD §5/§6)
# ============================================================================

def _compute_value_score(
    *,
    active_pods: list[dict],
    alerts_fired: int,
    alerts_acted_on: int,
    aria_winrate: float | None,
    aria_count: int,
    time_to_first_value_days: int | None,
    feature_adoption_rate: float,
) -> float:
    """§5 weighted sum, with missing-data weight redistribution: a
    component with no underlying data (not "zero performance", but
    genuinely absent — e.g. no pods at all) is excluded and its weight
    redistributed proportionally across the remaining components, rather
    than defaulting to 0. This is an explicit decision, undocumented in
    the PRD — a Pods-only user with no Aria exposure shouldn't be
    penalized as if they'd failed at something they never attempted.
    time_to_first_value_inverse is the one exception: it degrades to 0
    rather than being excluded, since "no first value yet" is itself
    informative, not missing data.

    The PRD's own §5 weight is named alert_pnl_saved_normalized, but that
    figure is never computed this pass (see _compute_alert_signals'
    docstring — no price-history data source exists to estimate it
    honestly). This uses alerts_acted_on/alerts_fired instead, under the
    same 0.25 weight, as the best currently-computable proxy for "value
    realized from alerts" — a real $-based figure can replace this later
    without changing the weight or any caller.
    """
    components: dict[str, tuple[float, float]] = {}  # name -> (value, weight)

    if active_pods:
        progress = sum(
            min(1.0, float(p["current_amount"]) / float(p["target_amount"]))
            for p in active_pods
            if p.get("target_amount")
        ) / len(active_pods)
        components["pod_goal_progress"] = (progress, 0.20)

    if alerts_fired > 0:
        components["alert_action_rate"] = (alerts_acted_on / alerts_fired, 0.25)

    if aria_count > 0 and aria_winrate is not None:
        components["aria_winrate"] = (aria_winrate, 0.25)

    ttfv_inverse = (1 / (1 + time_to_first_value_days / 7)) if time_to_first_value_days is not None else 0.0
    components["time_to_first_value"] = (ttfv_inverse, 0.10)

    components["feature_adoption"] = (feature_adoption_rate, 0.20)

    total_weight = sum(w for _, w in components.values())
    if total_weight == 0:
        return 0.0

    weighted_sum = sum(v * (w / total_weight) for v, w in components.values())
    return round(100 * weighted_sum, 2)


async def _compute_churn_risk(
    supabase,
    *,
    user_id: str,
    tier: str,
    last_sign_in_at: datetime | None,
    value_to_price_ratio: float | None,
    alerts_fired: int,
    alerts_acted_on: int,
) -> tuple[float, str, list[str]]:
    """§6 rules-based MVP. Only the 5 computable signals — "support ticket
    / dispute filed" is omitted, no such table exists anywhere in this
    codebase (verified). Thresholds below are placeholders, flagged
    tunable — the PRD gives weights but no cutoffs."""
    reasons: list[str] = []
    triggered_weight = 0

    if tier != "free" and last_sign_in_at is not None:
        if (datetime.now(UTC) - last_sign_in_at) >= timedelta(days=7):
            triggered_weight += 3
            reasons.append("no_login_7d")

    if value_to_price_ratio is not None and value_to_price_ratio < 0.5:
        recent_result = await asyncio.to_thread(
            lambda: supabase.table("value_ledger_rollups")
            .select("value_to_price_ratio")
            .eq("user_id", user_id)
            .order("rollup_date", desc=True)
            .limit(13)  # + today's not-yet-written row = 14
            .execute()
        )
        prior = [r["value_to_price_ratio"] for r in recent_result.data]
        if len(prior) >= 13 and all(r is not None and r < 0.5 for r in prior):
            triggered_weight += 3
            reasons.append("value_to_price_ratio_below_threshold_2w")

    sub_result = await asyncio.to_thread(
        lambda: supabase.table("subscriptions")
        .select("status, past_due_since")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(1)
        .maybe_single()
        .execute()
    )
    sub = sub_result.data if sub_result else None
    if sub and sub.get("status") == "past_due" and sub.get("past_due_since"):
        past_due_since = datetime.fromisoformat(sub["past_due_since"].replace("Z", "+00:00"))
        grace_cutoff = past_due_since + timedelta(days=3)
        if abs((datetime.now(UTC) - grace_cutoff).total_seconds()) <= 24 * 3600:
            triggered_weight += 3
            reasons.append("payment_failed_grace_expiring")

    if alerts_fired > 0 and alerts_acted_on == 0:
        triggered_weight += 2
        reasons.append("zero_alert_action_30d")

    pace_result = await asyncio.to_thread(
        lambda: supabase.table("value_ledger_rollups")
        .select("pod_pace_delta_pct")
        .eq("user_id", user_id)
        .order("rollup_date", desc=True)
        .limit(20)  # + today's not-yet-written row = 21
        .execute()
    )
    prior_pace = [r["pod_pace_delta_pct"] for r in pace_result.data]
    if len(prior_pace) >= 20 and all(p is not None and p <= -50 for p in prior_pace):
        triggered_weight += 2
        reasons.append("pod_pace_below_50pct_3w")

    score = round(100 * triggered_weight / CHURN_TOTAL_WEIGHT, 2)
    level = "high" if score >= 60 else "medium" if score >= 30 else "low"
    return score, level, reasons


async def _is_upsell_candidate(supabase, user_id: str, tier: str, value_score: float) -> bool:
    if tier != "free" or value_score < 70:
        return False
    recent_result = await asyncio.to_thread(
        lambda: supabase.table("value_ledger_rollups")
        .select("value_score")
        .eq("user_id", user_id)
        .order("rollup_date", desc=True)
        .limit(13)
        .execute()
    )
    prior = [r["value_score"] for r in recent_result.data]
    return len(prior) >= 13 and all(v is not None and v >= 70 for v in prior)


# ============================================================================
# Aria narration (Phase 2 surfacing)
# ============================================================================

async def _maybe_narrate_to_aria(
    supabase, user_id: str, rollup_date: date, pod_pace_delta: float | None, alerts_fired: int, alerts_acted_on: int
) -> None:
    """Only for users with something narratable — not every user, every
    day. severity='info' deliberately: keeps these entirely out of the
    proactive-check cron's batched delivery pipeline (only warning/critical
    are proactive-eligible — confirmed against src/lib/aria/findings.ts and
    20260814000003_extend_aria_findings_for_scanner_alerts.sql's own
    reasoning for the same choice). Passive only — surfaced when the user
    opens Aria chat. No churn-risk finding is ever written here; churn
    scores stay internal/dashboard-only.

    Uses alerts_acted_on/alerts_fired rather than the PRD's
    alert_pnl_saved — see _compute_alert_signals' docstring for why a
    real $ figure isn't computed this pass. A zero-action rate despite
    several firings is exactly the kind of thing worth Aria mentioning.
    """
    asset = f"VALUE_LEDGER:{rollup_date}"

    if pod_pace_delta is not None and abs(pod_pace_delta) >= 20:
        await upsert_finding(
            supabase,
            user_id=user_id,
            source_agent="mnemosyne",
            finding_type="portfolio_review",
            severity="info",
            asset=asset,
            raw_data={"pace_delta_pct": pod_pace_delta},
        )

    if alerts_fired >= 3 and alerts_acted_on == 0:
        await upsert_finding(
            supabase,
            user_id=user_id,
            source_agent="mnemosyne",
            finding_type="risk_check",
            severity="info",
            asset=asset,
            raw_data={"alerts_fired_30d": alerts_fired, "alerts_acted_on_30d": alerts_acted_on},
        )
