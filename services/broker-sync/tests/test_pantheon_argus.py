from app.pantheon import argus
from tests.conftest import FakeSupabase


def position_row(**overrides):
    base = {
        "symbol": "BTCUSDT",
        "side": "long",
        "unrealized_pnl_pct": -12,
        "entry_price": 50000,
        "mark_price": 44000,
    }
    base.update(overrides)
    return base


def connection(**overrides):
    base = {"id": "conn-1", "user_id": "user-1"}
    base.update(overrides)
    return base


def _configure_no_portfolio_drawdown(fake: FakeSupabase) -> None:
    fake.select_responses[("positions", "*")] = []
    fake.select_responses[("manual_assets", "value, currency")] = []
    fake.select_responses[("portfolio_snapshots", "total_net_worth")] = []


async def test_writes_a_finding_on_bucket_change():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = [
        {"id": "pos-1", "symbol": "BTCUSDT", "side": "long", "argus_last_severity": "none"}
    ]
    _configure_no_portfolio_drawdown(fake)

    await argus.evaluate_argus(fake, connection(), [position_row(unrealized_pnl_pct=-12)])

    updates = fake.calls_for("positions", "update")
    assert len(updates) == 1
    assert updates[0].values == {"argus_last_severity": "warning"}

    inserts = fake.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["severity"] == "warning"
    assert inserts[0].values["dedup_key"] == "argus:loss_warning:BTCUSDT:warning"


async def test_critical_bucket_at_15_pct_loss():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = [
        {"id": "pos-1", "symbol": "BTCUSDT", "side": "long", "argus_last_severity": "none"}
    ]
    _configure_no_portfolio_drawdown(fake)

    await argus.evaluate_argus(fake, connection(), [position_row(unrealized_pnl_pct=-18)])

    inserts = fake.calls_for("aria_findings", "insert")
    assert inserts[0].values["severity"] == "critical"


async def test_no_write_when_bucket_is_unchanged():
    """Two consecutive cycles at an unchanged bucket must produce exactly
    one finding, not one per cycle — the whole point of the
    argus_last_severity short-circuit. Modeled as a single call with the
    prior state pre-set to the same bucket the position is already in
    (the state a second identical cycle would have persisted), same
    pattern test_connection_health_notifications.py uses for its
    "does not resend once already notified" cases."""
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = [
        {"id": "pos-1", "symbol": "BTCUSDT", "side": "long", "argus_last_severity": "warning"}
    ]
    _configure_no_portfolio_drawdown(fake)

    await argus.evaluate_argus(fake, connection(), [position_row(unrealized_pnl_pct=-12)])

    assert fake.calls_for("positions", "update") == []
    assert fake.calls_for("aria_findings", "insert") == []


async def test_recovering_above_threshold_clears_severity_without_writing_a_finding():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = [
        {"id": "pos-1", "symbol": "BTCUSDT", "side": "long", "argus_last_severity": "warning"}
    ]
    _configure_no_portfolio_drawdown(fake)

    await argus.evaluate_argus(fake, connection(), [position_row(unrealized_pnl_pct=-1)])

    updates = fake.calls_for("positions", "update")
    assert updates[0].values == {"argus_last_severity": "none"}
    assert fake.calls_for("aria_findings", "insert") == []


class TestPortfolioDrawdown:
    async def test_writes_a_warning_when_drawdown_exceeds_15_pct(self):
        fake = FakeSupabase()
        fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = []
        fake.select_responses[("positions", "*")] = [
            {"id": "pos-1", "size": 1, "entry_price": 50000, "mark_price": 40000, "currency": "USD"}
        ]
        fake.select_responses[("manual_assets", "value, currency")] = []
        fake.select_responses[("portfolio_snapshots", "total_net_worth")] = [{"total_net_worth": 100000}]

        await argus.evaluate_argus(fake, connection(), [])

        inserts = fake.calls_for("aria_findings", "insert")
        assert len(inserts) == 1
        assert inserts[0].values["dedup_key"] == "argus:loss_warning:PORTFOLIO:warning"
        assert inserts[0].values["raw_data"]["drawdown_from_peak_pct"] == 60.0

    async def test_no_finding_when_no_snapshot_history(self):
        fake = FakeSupabase()
        fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = []
        fake.select_responses[("positions", "*")] = []
        fake.select_responses[("manual_assets", "value, currency")] = []
        fake.select_responses[("portfolio_snapshots", "total_net_worth")] = []

        await argus.evaluate_argus(fake, connection(), [])

        assert fake.calls_for("aria_findings", "insert") == []

    async def test_no_finding_when_positions_and_manual_assets_span_multiple_currencies(self):
        fake = FakeSupabase()
        fake.select_responses[("positions", "id, symbol, side, argus_last_severity")] = []
        fake.select_responses[("positions", "*")] = [
            {"id": "pos-1", "size": 1, "entry_price": 50000, "mark_price": 40000, "currency": "USD"}
        ]
        fake.select_responses[("manual_assets", "value, currency")] = [{"value": 1000, "currency": "NGN"}]
        fake.select_responses[("portfolio_snapshots", "total_net_worth")] = [{"total_net_worth": 100000}]

        await argus.evaluate_argus(fake, connection(), [])

        assert fake.calls_for("aria_findings", "insert") == []
