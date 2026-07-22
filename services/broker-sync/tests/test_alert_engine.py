from datetime import UTC, datetime, timedelta

import pytest

from app import alert_engine
from tests.conftest import FakeSupabase

USER_ID = "user-1"

BTC_POSITION = {
    "user_id": USER_ID,
    "symbol": "BTCUSDT",
    "side": "long",
    "size": 1.0,
    "entry_price": 60000.0,
    "mark_price": 65000.0,
    "margin_used": 6500.0,
}


def make_alert(**overrides) -> dict:
    base = {
        "id": "alert-1",
        "user_id": USER_ID,
        "symbol": None,
        "condition_type": "pnl_pct",
        "operator": "above",
        "threshold": 5,
        "is_active": True,
        "last_triggered_at": None,
    }
    base.update(overrides)
    return base


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(alert_engine, "get_service_client", lambda: fake)
    return fake


@pytest.fixture(autouse=True)
def no_real_delivery(monkeypatch):
    """Every test in this file cares about evaluation logic, not
    delivery — delivery has its own test file. Stubbed to always
    "succeed" here so _fire_alert's delivered_via bookkeeping runs
    without needing real Resend/aria_conversations config.
    """
    monkeypatch.setattr(alert_engine, "deliver_alert_email", _fake_deliver_email)
    monkeypatch.setattr(alert_engine, "deliver_alert_in_app", _fake_deliver_in_app)


async def _fake_deliver_email(**kwargs):
    return True


async def _fake_deliver_in_app(**kwargs):
    return True


class TestConditionEvaluation:
    """One test per alert_type this engine understands, per spec: 'Unit
    test each alert_type's evaluation logic against known input values.'
    """

    async def test_price_above_fires_when_mark_price_exceeds_threshold(self, fake_supabase):
        alert = make_alert(condition_type="price", symbol="BTCUSDT", operator="above", threshold=64000)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_price_below_does_not_fire_when_mark_price_is_above_threshold(self, fake_supabase):
        alert = make_alert(condition_type="price", symbol="BTCUSDT", operator="below", threshold=64000)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]

        await alert_engine.evaluate_alert(alert)

        assert fake_supabase.calls_for("alert_history", "insert") == []

    async def test_price_alert_skipped_when_symbol_not_currently_held(self, fake_supabase):
        # No cached/synced position in ETHUSDT — nothing to evaluate against.
        alert = make_alert(condition_type="price", symbol="ETHUSDT", operator="above", threshold=1000)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]

        await alert_engine.evaluate_alert(alert)

        assert fake_supabase.calls_for("alert_history", "insert") == []

    async def test_pnl_pct_above_fires_on_portfolio_wide_gain(self, fake_supabase):
        # entry 60000, mark 65000, long, size 1 -> +5000 pnl on 60000 entry value = +8.33%
        alert = make_alert(condition_type="pnl_pct", operator="above", threshold=5)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_pnl_abs_below_fires_on_portfolio_wide_loss(self, fake_supabase):
        losing_position = {**BTC_POSITION, "mark_price": 55000.0}  # -5000 pnl
        alert = make_alert(condition_type="pnl_abs", operator="below", threshold=-1000)
        fake_supabase.select_responses[("positions", "*")] = [losing_position]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_margin_pct_above_fires_when_utilization_exceeds_threshold(self, fake_supabase):
        # net worth = position value (65000) + 0 manual assets; margin_used 6500 -> 10%
        alert = make_alert(condition_type="margin_pct", operator="above", threshold=5)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("manual_assets", "value")] = []
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_drawdown_pct_fires_relative_to_historical_peak(self, fake_supabase):
        # peak 100000, current net worth 65000 -> 35% drawdown
        alert = make_alert(condition_type="drawdown_pct", operator="above", threshold=20)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("manual_assets", "value")] = []
        fake_supabase.select_responses[("portfolio_snapshots", "total_net_worth")] = [
            {"total_net_worth": 100000.0}
        ]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_drawdown_pct_skipped_with_no_snapshot_history(self, fake_supabase):
        alert = make_alert(condition_type="drawdown_pct", operator="above", threshold=20)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("manual_assets", "value")] = []
        fake_supabase.select_responses[("portfolio_snapshots", "total_net_worth")] = []

        await alert_engine.evaluate_alert(alert)

        assert fake_supabase.calls_for("alert_history", "insert") == []


class TestCooldown:
    """Spec: 'Test cooldown window (alert doesn't re-fire within 4h, does
    fire after).'"""

    async def test_does_not_refire_within_cooldown_window(self, fake_supabase):
        recent = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        alert = make_alert(condition_type="pnl_pct", operator="above", threshold=5, last_triggered_at=recent)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]

        await alert_engine.evaluate_alert(alert)

        assert fake_supabase.calls_for("alert_history", "insert") == []

    async def test_refires_after_cooldown_window_elapses(self, fake_supabase):
        old = (datetime.now(UTC) - timedelta(hours=5)).isoformat()
        alert = make_alert(condition_type="pnl_pct", operator="above", threshold=5, last_triggered_at=old)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        assert len(fake_supabase.calls_for("alert_history", "insert")) == 1

    async def test_fired_alert_updates_last_triggered_at(self, fake_supabase):
        alert = make_alert(condition_type="pnl_pct", operator="above", threshold=5)
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_alert(alert)

        updates = fake_supabase.calls_for("alerts", "update")
        assert len(updates) == 1
        assert updates[0].values["last_triggered_at"] is not None


class TestNoDirectBrokerCalls:
    """Spec: 'Test that engine reads from cache, never calls broker APIs
    directly (mock and assert no external broker call happens).'
    alert_engine.py never imports BROKER_CLIENTS or any BrokerClient
    subclass — asserted here structurally rather than by mocking a
    specific HTTP call, so it also catches a future accidental import.
    """

    def test_alert_engine_module_does_not_import_broker_clients(self):
        import inspect

        source = inspect.getsource(alert_engine)
        assert "BROKER_CLIENTS" not in source
        assert "BybitClient" not in source
        assert "BinanceClient" not in source
        assert "KucoinClient" not in source
        assert "MetaTraderClient" not in source

    async def test_evaluate_all_alerts_only_queries_supabase_tables(self, fake_supabase):
        fake_supabase.select_responses[("alerts", "*")] = [
            make_alert(condition_type="pnl_pct", operator="above", threshold=5)
        ]
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]

        await alert_engine.evaluate_all_alerts()

        queried_tables = {c.table_name for c in fake_supabase.calls}
        allowed_tables = {"alerts", "positions", "manual_assets", "portfolio_snapshots", "users", "alert_history"}
        assert queried_tables <= allowed_tables

    async def test_multiple_simultaneous_alerts_all_fire_none_dropped(self, fake_supabase):
        """Day 6 launch-sprint item: 'test multiple simultaneous alerts
        firing at once — confirm none get dropped or duplicated.' Three
        alerts that all satisfy their condition in the same
        evaluate_all_alerts() cycle — asserts all three actually reach
        alert_history (none silently dropped) and each exactly once (no
        duplicate firing within a single cycle)."""
        fake_supabase.select_responses[("alerts", "*")] = [
            make_alert(id="alert-price", condition_type="price", symbol="BTCUSDT", operator="above", threshold=64000),
            make_alert(id="alert-pnl-pct", condition_type="pnl_pct", operator="above", threshold=5),
            make_alert(id="alert-margin", condition_type="margin_pct", operator="above", threshold=1),
        ]
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]
        fake_supabase.select_responses[("manual_assets", "value")] = []

        await alert_engine.evaluate_all_alerts()

        history_inserts = fake_supabase.calls_for("alert_history", "insert")
        fired_alert_ids = [c.values["alert_id"] for c in history_inserts]
        assert sorted(fired_alert_ids) == ["alert-margin", "alert-pnl-pct", "alert-price"]
        # Each id appears exactly once — not duplicated within this cycle.
        assert len(fired_alert_ids) == len(set(fired_alert_ids))

    async def test_one_alert_failing_does_not_block_the_others_in_the_same_cycle(self, fake_supabase):
        """A single malformed/erroring alert must not take the rest of
        the batch down with it — evaluate_all_alerts catches per-alert,
        per its own module docstring/loop. Alert 'alert-bad' is missing
        'operator', which raises inside _condition_met; the two well-formed
        alerts on either side of it in the list must still fire."""
        bad_alert = make_alert(id="alert-bad", condition_type="pnl_pct", threshold=5)
        del bad_alert["operator"]  # _condition_met(alert["operator"], ...) raises KeyError

        fake_supabase.select_responses[("alerts", "*")] = [
            make_alert(id="alert-before", condition_type="pnl_pct", operator="above", threshold=5),
            bad_alert,
            make_alert(id="alert-after", condition_type="margin_pct", operator="above", threshold=1),
        ]
        fake_supabase.select_responses[("positions", "*")] = [BTC_POSITION]
        fake_supabase.select_responses[("users", "email")] = [{"email": "user@example.com"}]
        fake_supabase.select_responses[("manual_assets", "value")] = []

        await alert_engine.evaluate_all_alerts()

        history_inserts = fake_supabase.calls_for("alert_history", "insert")
        fired_alert_ids = {c.values["alert_id"] for c in history_inserts}
        assert fired_alert_ids == {"alert-before", "alert-after"}
