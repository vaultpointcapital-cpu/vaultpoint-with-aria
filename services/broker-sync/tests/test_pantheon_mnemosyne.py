from datetime import UTC, datetime

import pytest

from app.pantheon import mnemosyne
from tests.conftest import FakeSupabase


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(mnemosyne, "get_service_client", lambda: fake)
    return fake


def _configure_baseline(fake: FakeSupabase, *, equity=50000, positions=None) -> None:
    fake.select_responses[("broker_connections", "user_id")] = [{"user_id": "user-1"}]
    fake.select_responses[("portfolio_snapshots", "total_net_worth")] = [{"total_net_worth": equity}]
    fake.select_responses[("positions", "symbol, unrealized_pnl_pct")] = positions or []
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = []


async def test_daily_report_includes_best_and_worst_performer(fake_supabase):
    _configure_baseline(
        fake_supabase,
        positions=[
            {"symbol": "BTC", "unrealized_pnl_pct": 12.0},
            {"symbol": "ETH", "unrealized_pnl_pct": -8.0},
        ],
    )

    await mnemosyne.mnemosyne_daily()

    inserts = fake_supabase.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    raw_data = inserts[0].values["raw_data"]
    assert raw_data["equity"] == 50000
    assert raw_data["open_position_count"] == 2
    assert raw_data["best_performer"]["symbol"] == "BTC"
    assert raw_data["worst_performer"]["symbol"] == "ETH"
    assert inserts[0].values["severity"] == "info"
    assert inserts[0].values["finding_type"] == "portfolio_review"


async def test_no_report_when_todays_snapshot_is_missing(fake_supabase):
    fake_supabase.select_responses[("broker_connections", "user_id")] = [{"user_id": "user-1"}]
    fake_supabase.select_responses[("portfolio_snapshots", "total_net_worth")] = []

    await mnemosyne.mnemosyne_daily()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_daily_dedup_key_is_stamped_with_todays_date(fake_supabase):
    _configure_baseline(fake_supabase)

    await mnemosyne.mnemosyne_daily()

    today = str(datetime.now(UTC).date())
    inserts = fake_supabase.calls_for("aria_findings", "insert")
    assert inserts[0].values["dedup_key"] == f"mnemosyne:portfolio_review:PORTFOLIO:{today}:info"


async def test_weekly_dedup_key_is_stamped_with_the_iso_week_not_the_daily_date(fake_supabase):
    _configure_baseline(fake_supabase)

    await mnemosyne.mnemosyne_weekly()

    inserts = fake_supabase.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    dedup_key = inserts[0].values["dedup_key"]
    assert dedup_key.startswith("mnemosyne:portfolio_review:PORTFOLIO:week-")
    today = str(datetime.now(UTC).date())
    assert today not in dedup_key
