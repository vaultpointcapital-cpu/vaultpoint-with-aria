import pytest

from app import alert_delivery
from tests.conftest import FakeSupabase


class _FakeResponse:
    def raise_for_status(self):
        pass


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient so no real network call is ever
    made in tests — Resend's own sandbox mode is for manual/integration
    verification against their real API, not this suite (no other test
    in this codebase makes a real network call, matching that
    convention)."""

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


class TestEmailDelivery:
    async def test_sends_email_via_resend_when_configured(self, monkeypatch):
        monkeypatch.setattr(alert_delivery.settings, "resend_api_key", "test-resend-key")
        monkeypatch.setattr(alert_delivery.settings, "alert_email_from", "alerts@vaultpoint.test")
        monkeypatch.setattr(alert_delivery.httpx, "AsyncClient", _FakeAsyncClient)

        sent = await alert_delivery.deliver_alert_email(
            to_email="user@example.com",
            subject="Test alert",
            message="BTCUSDT crossed above $65,000",
            app_url="https://app.vaultpoint.test",
        )

        assert sent is True
        assert len(_FakeAsyncClient.captured_calls) == 1
        call = _FakeAsyncClient.captured_calls[0]
        assert call["json"]["to"] == ["user@example.com"]
        assert "BTCUSDT crossed above $65,000" in call["json"]["html"]
        assert call["headers"]["Authorization"] == "Bearer test-resend-key"

    async def test_skips_delivery_when_resend_not_configured(self, monkeypatch):
        monkeypatch.setattr(alert_delivery.settings, "resend_api_key", None)
        monkeypatch.setattr(alert_delivery.settings, "alert_email_from", None)
        monkeypatch.setattr(alert_delivery.httpx, "AsyncClient", _FakeAsyncClient)

        sent = await alert_delivery.deliver_alert_email(
            to_email="user@example.com", subject="Test", message="Test", app_url="https://app.vaultpoint.test"
        )

        assert sent is False
        assert _FakeAsyncClient.captured_calls == []

    async def test_returns_false_rather_than_raising_on_delivery_failure(self, monkeypatch):
        monkeypatch.setattr(alert_delivery.settings, "resend_api_key", "test-resend-key")
        monkeypatch.setattr(alert_delivery.settings, "alert_email_from", "alerts@vaultpoint.test")

        class _RaisingClient(_FakeAsyncClient):
            async def post(self, *args, **kwargs):
                raise RuntimeError("network error")

        monkeypatch.setattr(alert_delivery.httpx, "AsyncClient", _RaisingClient)

        sent = await alert_delivery.deliver_alert_email(
            to_email="user@example.com", subject="Test", message="Test", app_url="https://app.vaultpoint.test"
        )

        assert sent is False


class TestInAppDelivery:
    async def test_inserts_into_aria_conversations(self, monkeypatch):
        fake = FakeSupabase()
        monkeypatch.setattr(alert_delivery, "get_service_client", lambda: fake)

        sent = await alert_delivery.deliver_alert_in_app(
            user_id="user-1", message="Portfolio P&L crossed above 5%", message_type="PROFIT_ALERT"
        )

        assert sent is True
        inserts = fake.calls_for("aria_conversations", "insert")
        assert len(inserts) == 1
        assert inserts[0].values["channel"] == "web"
        assert inserts[0].values["role"] == "assistant"
        assert inserts[0].values["message_type"] == "PROFIT_ALERT"

    async def test_returns_false_rather_than_raising_when_table_unavailable(self, monkeypatch):
        class _RaisingSupabase:
            def table(self, name):
                raise RuntimeError("relation \"aria_conversations\" does not exist")

        monkeypatch.setattr(alert_delivery, "get_service_client", lambda: _RaisingSupabase())

        sent = await alert_delivery.deliver_alert_in_app(
            user_id="user-1", message="Test", message_type="RISK_CHECK"
        )

        assert sent is False
