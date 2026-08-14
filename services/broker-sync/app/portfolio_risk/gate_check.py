"""Portfolio Risk Aggregator — the cheap synchronous reads Decision Gate's
_route_auto() calls on every routing pass. All the actual aggregation
work already happened in service.py's scheduled job; these are one or
two plain .select() calls against its output, never a recompute.
"""

import asyncio

from ..config import settings
from .exposure import FxPair, classify_symbol


async def is_circuit_breaker_tripped(supabase, book_type: str, book_scope_id: str) -> bool:
    result = await asyncio.to_thread(
        lambda: supabase.table("book_risk_state")
        .select("tripped")
        .eq("book_type", book_type)
        .eq("book_scope_id", book_scope_id)
        .maybe_single()
        .execute()
    )
    return bool(result.data and result.data.get("tripped"))


async def is_concentration_capped(supabase, book_type: str, book_scope_id: str, symbol: str) -> bool:
    """True if the book's ALREADY-COMPUTED exposure to either currency leg
    of `symbol` is at/above the configured cap. Checks current state, not
    a projected post-trade figure — _route_auto() never computes an
    actual position size today (only validates stop_distance > 0), so
    there's nothing to project forward; see the migration's header
    comment. Fails open (returns False) when there's nothing to evaluate
    against — an unclassified symbol, no exposure rows yet, or no
    baseline equity yet — rather than blocking every auto-trade before
    the aggregator has run once for this book.
    """
    classified = classify_symbol(symbol)
    if classified is None:
        return False

    currencies = [classified.base, classified.quote] if isinstance(classified, FxPair) else [classified.base]
    # USD is the numeraire, never itself a "concentration."
    currencies = [c for c in currencies if c != "USD"]
    if not currencies:
        return False

    exposure_result = await asyncio.to_thread(
        lambda: supabase.table("book_exposure_state")
        .select("currency_or_asset, net_notional_usd")
        .eq("book_type", book_type)
        .eq("book_scope_id", book_scope_id)
        .in_("currency_or_asset", currencies)
        .execute()
    )
    rows = exposure_result.data or []
    if not rows:
        return False

    # Reuses book_risk_state.baseline_equity as the equity figure the cap
    # is expressed against — avoids computing/storing a third notion of
    # "book size" alongside baseline_equity and net_notional_usd.
    risk_state_result = await asyncio.to_thread(
        lambda: supabase.table("book_risk_state")
        .select("baseline_equity")
        .eq("book_type", book_type)
        .eq("book_scope_id", book_scope_id)
        .maybe_single()
        .execute()
    )
    baseline_equity = (risk_state_result.data or {}).get("baseline_equity")
    if not baseline_equity or baseline_equity <= 0:
        return False

    cap_fraction = settings.portfolio_risk_concentration_cap_pct / 100
    return any(abs(row["net_notional_usd"]) >= baseline_equity * cap_fraction for row in rows)
