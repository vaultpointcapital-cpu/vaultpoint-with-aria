"""Aria Pantheon — Hermes (POSITION): opportunity scouting.

Own APScheduler job (scheduler.py's run_hermes_scan), not the 60s poller
— needs external market data, so kept on a longer cadence per the spec.

No `references/market-signals.md` and no `risk_profile` field exist
anywhere in this codebase (checked: zero matches repo-wide for
risk_profile/risk_tolerance/riskProfile/risk_appetite — the only
risk-shaped field is broker_connections.managed_mode_risk_pct, scoped to
the unrelated Managed Mode autonomous-trading feature). The screen below
is defined here instead of deferring to either, and deliberately drops
any risk-profile alignment criterion rather than inventing new
user-profile infrastructure as a side effect of this worker:

  - CoinGecko /coins/markets (no API key) for 24h % move + volume — the
    same vendor fx_service.py already uses for crypto USD rates, but a
    different endpoint (/simple/price has no change/volume data), so
    CRYPTO_COINGECKO_IDS is reused for the id list, not re-fetched via
    fx_service's own function.
  - Positive moves only, both move % and volume must clear their
    threshold (config.py: hermes_move_threshold_pct, hermes_min_volume_usd).
  - Skip a symbol the user already holds an open real position in —
    Hermes is for new opportunities, Argus/Plutus already cover existing
    ones.
  - Skipped entirely for a user in cool-down (see _is_cool_down_active —
    a reimplementation of src/lib/aria/compliance.ts's computeCoolDown,
    since Python has no access to the TS AriaContext; kept in sync by
    hand, cross-reference this comment if that rule ever changes).

severity is always 'caution' — never urgent enough to interrupt.
finding_type='buy_signal', 4h expiry via dedup.py's
active_delivered_window_hours plus a read-side created_at filter (see
src/lib/aria/findings.ts) and this module's own cleanup of its stale
'new' rows at the start of each run.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx

from ..config import settings
from ..fx_service import CRYPTO_COINGECKO_IDS
from ..supabase_client import get_service_client
from .dedup import upsert_finding
from .networth import get_current_real_net_worth

logger = logging.getLogger("broker_sync")

COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets"
_COOL_DOWN_DROP_THRESHOLD_PCT = 10  # must match src/lib/aria/compliance.ts's COOL_DOWN_DROP_THRESHOLD_PCT


async def run_hermes_scan() -> None:
    supabase = get_service_client()

    await _expire_stale_findings(supabase)

    movers = await _fetch_screened_movers()
    if not movers:
        return

    users_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections").select("user_id").neq("health", "closed").execute()
    )
    user_ids = {row["user_id"] for row in users_result.data}

    for user_id in user_ids:
        try:
            await _evaluate_for_user(supabase, user_id, movers)
        except Exception:
            logger.exception("hermes: evaluation failed for user=%s", user_id)


async def _evaluate_for_user(supabase, user_id: str, movers: list[dict]) -> None:
    if await _is_cool_down_active(supabase, user_id):
        return

    held_symbols = await _get_held_real_symbols(supabase, user_id)

    for mover in movers:
        if mover["symbol"] in held_symbols:
            continue

        await upsert_finding(
            supabase,
            user_id=user_id,
            source_agent="hermes",
            finding_type="buy_signal",
            severity="caution",
            asset=mover["symbol"],
            raw_data={
                "symbol": mover["symbol"],
                "price_change_percentage_24h": mover["price_change_percentage_24h"],
                "total_volume": mover["total_volume"],
                "current_price": mover["current_price"],
            },
            active_delivered_window_hours=settings.hermes_finding_ttl_hours,
        )


async def _fetch_screened_movers() -> list[dict]:
    symbol_by_coingecko_id = {v: k for k, v in CRYPTO_COINGECKO_IDS.items()}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                COINGECKO_MARKETS_URL,
                params={
                    "vs_currency": "usd",
                    "ids": ",".join(CRYPTO_COINGECKO_IDS.values()),
                },
            )
            response.raise_for_status()
            payload = response.json()
    except Exception:
        logger.exception("hermes: CoinGecko /coins/markets fetch failed — skipping this scan.")
        return []

    movers = []
    for coin in payload:
        symbol = symbol_by_coingecko_id.get(coin.get("id"))
        if symbol is None:
            continue

        change_pct = coin.get("price_change_percentage_24h")
        volume = coin.get("total_volume")
        if change_pct is None or volume is None:
            continue

        if change_pct <= 0:
            continue  # positive moves only — a large drop is Argus/market territory, not an opportunity nudge
        if change_pct < settings.hermes_move_threshold_pct:
            continue
        if volume < settings.hermes_min_volume_usd:
            continue

        movers.append(
            {
                "symbol": symbol,
                "price_change_percentage_24h": change_pct,
                "total_volume": volume,
                "current_price": coin.get("current_price"),
            }
        )

    return movers


async def _get_held_real_symbols(supabase, user_id: str) -> set[str]:
    result = await asyncio.to_thread(
        lambda: supabase.table("positions")
        .select("symbol")
        .eq("user_id", user_id)
        .eq("reality", "real")
        .execute()
    )
    return {row["symbol"] for row in result.data}


async def _is_cool_down_active(supabase, user_id: str) -> bool:
    current_net_worth = await get_current_real_net_worth(supabase, user_id)
    if current_net_worth is None:
        return False

    today = str(datetime.now(UTC).date())
    snapshot_result = await asyncio.to_thread(
        lambda: supabase.table("portfolio_snapshots")
        .select("total_net_worth, snapshot_date")
        .eq("user_id", user_id)
        .lt("snapshot_date", today)
        .order("snapshot_date", desc=True)
        .limit(1)
        .execute()
    )
    if not snapshot_result.data:
        return False

    yesterday_total = snapshot_result.data[0]["total_net_worth"]
    if not yesterday_total or yesterday_total <= 0:
        return False

    drop = yesterday_total - current_net_worth
    if drop <= 0:
        return False  # flat or up

    drop_pct = (drop / yesterday_total) * 100
    return drop_pct >= _COOL_DOWN_DROP_THRESHOLD_PCT


async def _expire_stale_findings(supabase) -> None:
    """Flips this worker's own stale 'new' rows to 'expired' at the start
    of each run — no separate sweep job. Only ever touches its own
    source_agent/finding_type so this can't interfere with any other
    worker's findings."""
    cutoff = (datetime.now(UTC) - timedelta(hours=settings.hermes_finding_ttl_hours)).isoformat()
    await asyncio.to_thread(
        lambda: supabase.table("aria_findings")
        .update({"status": "expired"})
        .eq("source_agent", "hermes")
        .eq("finding_type", "buy_signal")
        .eq("status", "new")
        .lt("created_at", cutoff)
        .execute()
    )
