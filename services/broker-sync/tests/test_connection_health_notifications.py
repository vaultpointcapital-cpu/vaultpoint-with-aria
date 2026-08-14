from datetime import UTC, datetime, timedelta

import pytest

from app import connection_health_notifications as notifications
from tests.conftest import FakeSupabase


class _FakeResponse:
    def raise_for_status(self):
        pass


class _FakeAsyncClient:
    """Same network-free double test_alert_delivery.py already uses for
    httpx.AsyncClient — no real Resend call is ever made in this suite."""

    captured_calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, json=None):
        _FakeAsyncClient.captured_calls.append({"url": url, "headers": headers, "json": json})
        return _FakeResponse()


@pytest.fixture(autouse=True)
def reset_captured_calls():
    _FakeAsyncClient.captured_calls = []


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    fake.select_responses[("users", "email")] = [{"email": "user@example.com"}]
    monkeypatch.setattr(notifications, "get_service_client", lambda: fake)
    monkeypatch.setattr(notifications.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(notifications.settings, "resend_api_key", "test-resend-key")
    monkeypatch.setattr(notifications.settings, "alert_email_from", "alerts@vaultpoint.test")
    return fake


def connection(**overrides) -> dict:
    base = {
        "id": "conn-1",
        "user_id": "user-1",
        "label": "My Bybit",
        "broker": "bybit",
        "closed_reason": None,
        "last_success_at": None,
        "notified_health_state": None,
    }
    base.update(overrides)
    return base


def hours_ago(hours: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat()


class TestHealthyOrPendingRecovery:
    async def test_no_notice_when_nothing_was_previously_notified(self, fake_supabase):
        await notifications.notify_health_change(connection(notified_health_state=None), "healthy")

        assert _FakeAsyncClient.captured_calls == []
        assert fake_supabase.calls_for("aria_conversations", "insert") == []
        assert fake_supabase.calls_for("broker_connections", "update") == []

    async def test_sends_recovery_notice_and_clears_dedup_when_a_failure_was_notified(self, fake_supabase):
        await notifications.notify_health_change(connection(notified_health_state="auth_failed"), "healthy")

        assert len(_FakeAsyncClient.captured_calls) == 1
        assert "back" in _FakeAsyncClient.captured_calls[0]["json"]["subject"].lower()
        in_app = fake_supabase.calls_for("aria_conversations", "insert")
        assert len(in_app) == 1

        updates = fake_supabase.calls_for("broker_connections", "update")
        assert len(updates) == 1
        assert updates[0].values == {"notified_health_state": None}

    async def test_pending_also_counts_as_recovery(self, fake_supabase):
        await notifications.notify_health_change(connection(notified_health_state="stale"), "pending")

        assert len(_FakeAsyncClient.captured_calls) == 1


class TestAuthFailedAndClosed:
    @pytest.mark.parametrize("health", ["auth_failed", "closed"])
    async def test_sends_once_and_sets_dedup(self, fake_supabase, health):
        await notifications.notify_health_change(connection(notified_health_state=None), health)

        assert len(_FakeAsyncClient.captured_calls) == 1
        updates = fake_supabase.calls_for("broker_connections", "update")
        assert len(updates) == 1
        assert updates[0].values == {"notified_health_state": health}

    @pytest.mark.parametrize("health", ["auth_failed", "closed"])
    async def test_does_not_resend_once_already_notified(self, fake_supabase, health):
        await notifications.notify_health_change(connection(notified_health_state=health), health)

        assert _FakeAsyncClient.captured_calls == []
        assert fake_supabase.calls_for("broker_connections", "update") == []

    async def test_prop_breached_closed_gets_a_no_reconnect_note(self, fake_supabase):
        await notifications.notify_health_change(
            connection(notified_health_state=None, closed_reason="prop_breached"), "closed"
        )

        assert len(_FakeAsyncClient.captured_calls) == 1
        assert "can't be undone" in _FakeAsyncClient.captured_calls[0]["json"]["html"]


class TestStaleGracePeriod:
    async def test_no_notice_when_never_successfully_synced(self, fake_supabase):
        await notifications.notify_health_change(
            connection(notified_health_state=None, last_success_at=None), "stale"
        )

        assert _FakeAsyncClient.captured_calls == []

    async def test_no_notice_before_the_30_minute_grace_period_elapses(self, fake_supabase):
        await notifications.notify_health_change(
            connection(notified_health_state=None, last_success_at=hours_ago(0.25)), "stale"
        )

        assert _FakeAsyncClient.captured_calls == []
        assert fake_supabase.calls_for("broker_connections", "update") == []

    async def test_sends_once_the_30_minute_grace_period_has_elapsed(self, fake_supabase):
        await notifications.notify_health_change(
            connection(notified_health_state=None, last_success_at=hours_ago(1)), "stale"
        )

        assert len(_FakeAsyncClient.captured_calls) == 1
        updates = fake_supabase.calls_for("broker_connections", "update")
        assert updates[0].values == {"notified_health_state": "stale"}

    async def test_does_not_resend_once_already_notified_for_this_streak(self, fake_supabase):
        await notifications.notify_health_change(
            connection(notified_health_state="stale", last_success_at=hours_ago(2)), "stale"
        )

        assert _FakeAsyncClient.captured_calls == []
        assert fake_supabase.calls_for("broker_connections", "update") == []


async def test_degraded_never_notifies_regardless_of_prior_state(fake_supabase):
    for prior in (None, "auth_failed", "stale", "closed"):
        _FakeAsyncClient.captured_calls = []
        await notifications.notify_health_change(connection(notified_health_state=prior), "degraded")
        assert _FakeAsyncClient.captured_calls == []


class TestAlertsPausedNotice:
    async def test_sends_email_and_in_app_for_the_alert(self, fake_supabase):
        alert = {"id": "alert-1", "user_id": "user-1", "condition_type": "pnl_pct"}

        await notifications.notify_alerts_paused(alert)

        assert len(_FakeAsyncClient.captured_calls) == 1
        assert "paused" in _FakeAsyncClient.captured_calls[0]["json"]["subject"].lower()
        in_app = fake_supabase.calls_for("aria_conversations", "insert")
        assert len(in_app) == 1
        assert "pnl_pct" in in_app[0].values["content"]
