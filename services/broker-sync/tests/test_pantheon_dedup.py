from datetime import UTC, datetime, timedelta

from app.pantheon import dedup
from tests.conftest import FakeSupabase


def hours_ago(hours: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat()


async def test_inserts_on_first_call():
    fake = FakeSupabase()
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = []

    await dedup.upsert_finding(
        fake,
        user_id="user-1",
        source_agent="argus",
        finding_type="loss_warning",
        severity="warning",
        asset="BTC",
        raw_data={"unrealized_pnl_pct": -12},
    )

    inserts = fake.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["dedup_key"] == "argus:loss_warning:BTC:warning"
    assert inserts[0].values["status"] == "new"
    assert fake.calls_for("aria_findings", "update") == []


async def test_updates_in_place_when_an_active_new_row_already_exists():
    fake = FakeSupabase()
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = [
        {"id": "finding-1", "status": "new", "delivered_at": None}
    ]

    await dedup.upsert_finding(
        fake,
        user_id="user-1",
        source_agent="argus",
        finding_type="loss_warning",
        severity="warning",
        asset="BTC",
        raw_data={"unrealized_pnl_pct": -14},
    )

    assert fake.calls_for("aria_findings", "insert") == []
    updates = fake.calls_for("aria_findings", "update")
    assert len(updates) == 1
    assert updates[0].values == {"raw_data": {"unrealized_pnl_pct": -14}}
    assert updates[0].filters == [("eq", "id", "finding-1")]


async def test_updates_in_place_when_delivered_within_the_active_window():
    fake = FakeSupabase()
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = [
        {"id": "finding-1", "status": "delivered", "delivered_at": hours_ago(1)}
    ]

    await dedup.upsert_finding(
        fake,
        user_id="user-1",
        source_agent="hermes",
        finding_type="buy_signal",
        severity="caution",
        asset="ETH",
        raw_data={"price_change_percentage_24h": 12},
        active_delivered_window_hours=4.0,
    )

    assert fake.calls_for("aria_findings", "insert") == []
    assert len(fake.calls_for("aria_findings", "update")) == 1


async def test_inserts_again_once_outside_the_active_delivered_window():
    fake = FakeSupabase()
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = [
        {"id": "finding-1", "status": "delivered", "delivered_at": hours_ago(5)}
    ]

    await dedup.upsert_finding(
        fake,
        user_id="user-1",
        source_agent="hermes",
        finding_type="buy_signal",
        severity="caution",
        asset="ETH",
        raw_data={"price_change_percentage_24h": 12},
        active_delivered_window_hours=4.0,
    )

    assert fake.calls_for("aria_findings", "update") == []
    inserts = fake.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["status"] == "new"


async def test_inserts_again_once_a_dismissed_row_no_longer_counts_as_active():
    fake = FakeSupabase()
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = [
        {"id": "finding-1", "status": "dismissed", "delivered_at": None}
    ]

    await dedup.upsert_finding(
        fake,
        user_id="user-1",
        source_agent="plutus",
        finding_type="profit_alert",
        severity="caution",
        asset="BTC",
        raw_data={"unrealized_pnl_pct": 35},
    )

    assert fake.calls_for("aria_findings", "update") == []
    assert len(fake.calls_for("aria_findings", "insert")) == 1
