"""Portfolio Risk Aggregator — the scheduled job's actual work, wrapped by
scheduler.py's evaluate_portfolio_risk() for the lock/heartbeat shape
every other job in this service uses.

Runs between score_signals and evaluate_decision_gate (the PRD's own
"sitting between Signal Engine and Decision Gate" framing) — Decision
Gate's gate_check.py reads this job's output synchronously every cycle,
so this job must run first and at least as often (see config.py's
portfolio_risk_interval_seconds comment).

Per active book (scope.enumerate_active_books): compute currency/asset
net exposure from live REAL positions (reality='real' — excludes demo/
simulated capital from risk math, same boundary Pantheon's Argus/Plutus
and sync_service.py's _upsert_portfolio_snapshot already enforce
elsewhere), upsert book_exposure_state, then evaluate the book-level
monthly drawdown circuit breaker against a baseline captured once per
book and held until manually cleared (see the migration's header comment
for why this is deliberately not period-scoped — a trip must survive a
calendar-month rollover).

Tripping the breaker does NOT flatten existing positions — no execution
adapter places real orders anywhere in this codebase yet
(decision_gate/execution_adapter.py's NullExecutionAdapter is still the
only implementation, the same gap decision_gate/cooldown.py's own module
docstring already documents for its unrelated -10%/daily mechanism). It
blocks NEW auto-trades (via gate_check.is_circuit_breaker_tripped, read
by decision_gate/service.py), logs a Value Ledger event per affected
user, and sends a notification — logged explicitly that flattening is
blocked on that unbuilt layer, never silently pretended.
"""

import asyncio
import logging
from datetime import UTC, date, datetime

from .. import connection_health_notifications, value_ledger
from ..config import settings
from ..fx_service import FIAT_CURRENCIES, FX_MAJOR_CURRENCIES
from ..supabase_client import get_service_client
from . import exposure as exposure_mod
from . import scope

logger = logging.getLogger("broker_sync")


async def evaluate_portfolio_risk() -> None:
    supabase = get_service_client()
    fx_rates = await _load_fx_rates(supabase)

    for membership in await scope.enumerate_active_books(supabase):
        try:
            await _evaluate_book(supabase, membership, fx_rates)
        except Exception:
            logger.exception(
                "evaluate_portfolio_risk: failed for book_type=%s book_scope_id=%s",
                membership.book_type,
                membership.book_scope_id,
            )


async def _evaluate_book(supabase, membership: scope.BookMembership, fx_rates: dict[str, float]) -> None:
    positions = await _get_open_real_positions(supabase, membership.connection_ids)

    exposure = exposure_mod.aggregate_book_exposure(positions, fx_rates)
    await _write_exposure_state(supabase, membership, exposure, _position_counts_by_currency(positions))

    risk_state = await _get_or_init_risk_state(supabase, membership, positions)
    if risk_state["tripped"]:
        return  # stays tripped until manually cleared — no auto re-enable

    unrealized_pnl_sum = sum(float(p.get("unrealized_pnl") or 0) for p in positions)
    drawdown_pct = exposure_mod.compute_drawdown_pct(unrealized_pnl_sum, risk_state.get("baseline_equity"))
    await _update_current_drawdown(supabase, risk_state["id"], drawdown_pct)

    if drawdown_pct is not None and drawdown_pct <= -settings.portfolio_risk_monthly_drawdown_circuit_breaker_pct:
        await _trip_circuit_breaker(supabase, membership, risk_state, drawdown_pct)


async def _load_fx_rates(supabase) -> dict[str, float]:
    currencies = FIAT_CURRENCIES + FX_MAJOR_CURRENCIES
    result = await asyncio.to_thread(
        lambda: supabase.table("fx_rates")
        .select("currency, rate_to_usd")
        .in_("currency", currencies)
        .order("fetched_at", desc=True)
        .execute()
    )
    rates: dict[str, float] = {}
    for row in result.data or []:
        # Already ordered most-recent-first — the first row seen per
        # currency is the one to keep.
        rates.setdefault(row["currency"], float(row["rate_to_usd"]))
    return rates


async def _get_open_real_positions(supabase, connection_ids: list[str]) -> list[dict]:
    if not connection_ids:
        return []
    result = await asyncio.to_thread(
        lambda: supabase.table("positions")
        .select("symbol, side, size, entry_price, mark_price, unrealized_pnl, margin_used, broker_connection_id")
        .in_("broker_connection_id", connection_ids)
        .eq("reality", "real")
        .execute()
    )
    return result.data or []


def _position_counts_by_currency(positions: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for p in positions:
        classified = exposure_mod.classify_symbol(p.get("symbol") or "")
        if classified is None:
            continue
        currencies = (
            [classified.base, classified.quote]
            if isinstance(classified, exposure_mod.FxPair)
            else [classified.base]
        )
        for c in currencies:
            counts[c] = counts.get(c, 0) + 1
    return counts


async def _write_exposure_state(
    supabase, membership: scope.BookMembership, exposure: dict[str, float], position_counts: dict[str, int]
) -> None:
    if not exposure:
        return
    now_iso = datetime.now(UTC).isoformat()
    rows = [
        {
            "book_type": membership.book_type,
            "book_scope_id": membership.book_scope_id,
            "currency_or_asset": currency,
            "net_notional_usd": notional,
            "position_count": position_counts.get(currency, 0),
            "computed_at": now_iso,
        }
        for currency, notional in exposure.items()
    ]
    await asyncio.to_thread(
        lambda: supabase.table("book_exposure_state")
        .upsert(rows, on_conflict="book_type,book_scope_id,currency_or_asset")
        .execute()
    )


async def _get_or_init_risk_state(supabase, membership: scope.BookMembership, positions: list[dict]) -> dict:
    result = await asyncio.to_thread(
        lambda: supabase.table("book_risk_state")
        .select("*")
        .eq("book_type", membership.book_type)
        .eq("book_scope_id", membership.book_scope_id)
        .maybe_single()
        .execute()
    )
    existing = result.data
    today = date.today()

    if existing is None:
        baseline_equity, baseline_source = await _compute_baseline(supabase, membership, positions)
        # tripped/requires_human_review are explicit here (not left to the
        # table's own DB defaults) so the row this function returns is
        # immediately usable by the caller's `if risk_state["tripped"]`
        # check without a second round-trip.
        insert_result = await asyncio.to_thread(
            lambda: supabase.table("book_risk_state")
            .insert(
                {
                    "book_type": membership.book_type,
                    "book_scope_id": membership.book_scope_id,
                    "baseline_equity": baseline_equity,
                    "baseline_source": baseline_source,
                    "baseline_period_start": today.isoformat(),
                    "tripped": False,
                    "requires_human_review": False,
                }
            )
            .execute()
        )
        return insert_result.data[0]

    # Roll the baseline forward on a fresh calendar month — but ONLY if
    # the book isn't currently tripped (a trip must persist across the
    # rollover, per the migration's header comment — a fresh month must
    # not silently re-enable auto-trading).
    baseline_period_start = date.fromisoformat(existing["baseline_period_start"])
    if not existing["tripped"] and (today.year, today.month) != (baseline_period_start.year, baseline_period_start.month):
        baseline_equity, baseline_source = await _compute_baseline(supabase, membership, positions)
        updated_fields = {
            "baseline_equity": baseline_equity,
            "baseline_source": baseline_source,
            "baseline_period_start": today.isoformat(),
        }
        # Constructed locally rather than read back from the update's
        # response — this codebase's convention (cooldown.py's
        # trip_cooldown, connection_health_notifications.py's
        # _set_notified_state) is to never depend on an update's return
        # payload; the caller already knows exactly what it just wrote.
        await asyncio.to_thread(
            lambda: supabase.table("book_risk_state").update(updated_fields).eq("id", existing["id"]).execute()
        )
        return {**existing, **updated_fields}

    return existing


async def _compute_baseline(supabase, membership: scope.BookMembership, positions: list[dict]) -> tuple[float, str]:
    if membership.book_type == "managed_client":
        # A real, principled figure — sum of what clients actually
        # allocated to this trader's pathway.
        result = await asyncio.to_thread(
            lambda: supabase.table("managed_sub_accounts")
            .select("allocated_amount")
            .eq("trader_id", membership.book_scope_id)
            .eq("status", "active")
            .execute()
        )
        total = sum(float(r["allocated_amount"]) for r in (result.data or []))
        return total, "managed_allocation"

    # self_directed / prop — no universal live-equity feed exists for
    # these; margin_used is an APPROXIMATION, flagged in the migration's
    # column comment, same posture as decision_gate/cooldown.py's own
    # Phase 3 gap. Falls back to entry_price*size (leverage-less) when
    # margin_used is null, mirroring the MetaTrader client's own default.
    total = sum(
        float(p["margin_used"]) if p.get("margin_used") is not None else float(p["entry_price"]) * float(p["size"])
        for p in positions
    )
    return total, "position_proxy"


async def _update_current_drawdown(supabase, risk_state_id: str, drawdown_pct: float | None) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("book_risk_state")
        .update({"current_drawdown_pct": drawdown_pct})
        .eq("id", risk_state_id)
        .execute()
    )


async def _trip_circuit_breaker(
    supabase, membership: scope.BookMembership, risk_state: dict, drawdown_pct: float
) -> None:
    # Three independently-try/excepted steps — one failing must not block
    # the others (same posture decision_gate/service.py's _route_manual
    # takes toward its own alert-vs-finding split).
    try:
        await asyncio.to_thread(
            lambda: supabase.table("book_risk_state")
            .update(
                {
                    "tripped": True,
                    "tripped_at": datetime.now(UTC).isoformat(),
                    "requires_human_review": True,
                    "current_drawdown_pct": drawdown_pct,
                }
            )
            .eq("id", risk_state["id"])
            .execute()
        )
    except Exception:
        logger.exception(
            "evaluate_portfolio_risk: failed to persist circuit-breaker trip for book_type=%s book_scope_id=%s",
            membership.book_type,
            membership.book_scope_id,
        )

    affected_user_ids = await _affected_user_ids(supabase, membership)
    period_start = risk_state["baseline_period_start"]

    for user_id in affected_user_ids:
        try:
            await value_ledger.apply_event(
                supabase,
                user_id=user_id,
                event_name="circuit_breaker_tripped",
                idempotency_key=f"circuit_breaker_tripped:{membership.book_type}:{membership.book_scope_id}:{period_start}:{user_id}",
                properties={
                    "bookType": membership.book_type,
                    "bookScopeId": membership.book_scope_id,
                    "drawdownPct": drawdown_pct,
                    "baselineEquity": risk_state.get("baseline_equity"),
                },
                source="portfolio_risk_aggregator",
            )
        except Exception:
            logger.exception("evaluate_portfolio_risk: value_ledger emit failed for user=%s", user_id)

        try:
            await connection_health_notifications.notify_book_circuit_breaker_tripped(
                user_id, _book_label(membership), drawdown_pct
            )
        except Exception:
            logger.exception("evaluate_portfolio_risk: notification failed for user=%s", user_id)

    logger.warning(
        "evaluate_portfolio_risk: circuit breaker TRIPPED for book_type=%s book_scope_id=%s drawdown_pct=%.2f — "
        "blocking new auto-trades. Existing positions are NOT flattened: no execution adapter places real orders "
        "yet (decision_gate/execution_adapter.py's NullExecutionAdapter) — flattening is blocked on that same "
        "unbuilt layer, same gap decision_gate/cooldown.py's Phase 3 note already documents.",
        membership.book_type,
        membership.book_scope_id,
        drawdown_pct,
    )


async def _affected_user_ids(supabase, membership: scope.BookMembership) -> list[str]:
    if membership.book_type == "self_directed":
        return [membership.book_scope_id]  # book_scope_id IS the user_id for this book type

    if membership.book_type == "managed_client":
        trader_result = await asyncio.to_thread(
            lambda: supabase.table("managed_traders")
            .select("user_id")
            .eq("id", membership.book_scope_id)
            .maybe_single()
            .execute()
        )
        user_ids = [trader_result.data["user_id"]] if trader_result.data else []

        sub_accounts_result = await asyncio.to_thread(
            lambda: supabase.table("managed_sub_accounts")
            .select("client_user_id")
            .eq("trader_id", membership.book_scope_id)
            .eq("status", "active")
            .execute()
        )
        user_ids.extend(r["client_user_id"] for r in (sub_accounts_result.data or []))
        return user_ids

    return []  # prop — no real rows/users yet, logged as a no-op by the caller


def _book_label(membership: scope.BookMembership) -> str:
    if membership.book_type == "self_directed":
        return "your account"
    if membership.book_type == "managed_client":
        return "your managed trading pathway"
    return "the prop book"
