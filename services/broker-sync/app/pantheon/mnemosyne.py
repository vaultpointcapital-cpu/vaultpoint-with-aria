"""Aria Pantheon — Mnemosyne (REPORT): daily/weekly portfolio reports.

Two APScheduler `cron` jobs (scheduler.py's run_mnemosyne_daily/weekly),
not `interval` like every other job in this service — deliberate
deviation: an `interval` job here runs every N seconds from process
start, not at a fixed wall-clock time (see
settings.wallet_reconciliation_interval_seconds — that job does not
actually run at a fixed time of day). Mnemosyne needs actual midnight
alignment, which only `cron` gives.

Per active user (same "has at least one non-closed broker connection"
population Hermes scans): today's total_net_worth (from
portfolio_snapshots, written once daily by
sync_service._upsert_portfolio_snapshot), best/worst performer by
unrealized_pnl_pct (real positions only), open position count.
severity='info' always — a report is never urgent, so it never reaches
the proactive delivery path (src/lib/aria/findings.ts's proactive query
filters on warning/critical) and never needs the cool-down gate Hermes
needs.
"""

import asyncio
import logging
from datetime import UTC, datetime

from ..supabase_client import get_service_client
from .dedup import upsert_finding

logger = logging.getLogger("broker_sync")


async def mnemosyne_daily() -> None:
    await _run(period="daily", asset_suffix=str(datetime.now(UTC).date()))


async def mnemosyne_weekly() -> None:
    iso_year, iso_week, _ = datetime.now(UTC).isocalendar()
    await _run(period="weekly", asset_suffix=f"week-{iso_year}-{iso_week:02d}")


async def _run(*, period: str, asset_suffix: str) -> None:
    supabase = get_service_client()

    users_result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections").select("user_id").neq("health", "closed").execute()
    )
    user_ids = {row["user_id"] for row in users_result.data}

    for user_id in user_ids:
        try:
            await _report_for_user(supabase, user_id, period=period, asset_suffix=asset_suffix)
        except Exception:
            logger.exception("mnemosyne: %s report failed for user=%s", period, user_id)


async def _report_for_user(supabase, user_id: str, *, period: str, asset_suffix: str) -> None:
    today = str(datetime.now(UTC).date())
    snapshot_result = await asyncio.to_thread(
        lambda: supabase.table("portfolio_snapshots")
        .select("total_net_worth")
        .eq("user_id", user_id)
        .eq("snapshot_date", today)
        .execute()
    )
    if not snapshot_result.data:
        return  # today's snapshot hasn't been written yet — nothing to report

    equity = snapshot_result.data[0]["total_net_worth"]

    positions_result = await asyncio.to_thread(
        lambda: supabase.table("positions")
        .select("symbol, unrealized_pnl_pct")
        .eq("user_id", user_id)
        .eq("reality", "real")
        .execute()
    )
    positions = [p for p in positions_result.data if p.get("unrealized_pnl_pct") is not None]

    best = max(positions, key=lambda p: p["unrealized_pnl_pct"], default=None)
    worst = min(positions, key=lambda p: p["unrealized_pnl_pct"], default=None)

    await upsert_finding(
        supabase,
        user_id=user_id,
        source_agent="mnemosyne",
        finding_type="portfolio_review",
        severity="info",
        asset=f"PORTFOLIO:{asset_suffix}",
        raw_data={
            "period": period,
            "equity": equity,
            "open_position_count": len(positions_result.data),
            "best_performer": best,
            "worst_performer": worst,
        },
    )
