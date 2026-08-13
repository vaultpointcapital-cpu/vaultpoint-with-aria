import pytest

from app import payout_detection
from tests.conftest import FakeSupabase

AGREEMENT = {"id": "agreement-1", "broker_connection_id": "conn-1", "active": True}

CONNECTION = {
    "id": "conn-1",
    "user_id": "user-1",
    "broker": "metatrader",
    "health": "healthy",
    "mt_login": "12345",
    "mt_server": "Hantec-Live",
    "mt_platform": "mt5",
    "encrypted_mt_password": "cipher",
    "mt_password_iv": "iv",
    "metaapi_account_id": "acct-1",
    "metaapi_region": "london",
}


class _FakeMetaTraderClient:
    def __init__(self, balance: float, deals: list[dict] | None = None):
        self.balance = balance
        self.deals = deals or []
        self.closed = False
        self.deal_calls: list[tuple] = []

    async def get_balance(self) -> float:
        return self.balance

    async def get_history_deals(self, *, start_time, end_time):
        self.deal_calls.append((start_time, end_time))
        return self.deals

    async def aclose(self):
        self.closed = True


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(payout_detection, "get_service_client", lambda: fake)
    monkeypatch.setattr(payout_detection, "decrypt", lambda ciphertext, iv: "password")
    monkeypatch.setattr(payout_detection.settings, "app_base_url", None)  # skip real HTTP notify in tests
    return fake


def _seed(fake, *, connections=None, snapshots=None):
    fake.select_responses[("prop_payout_agreements", "*")] = [AGREEMENT]
    fake.select_responses[("broker_connections", "*")] = connections if connections is not None else [CONNECTION]
    fake.select_responses[("account_balance_snapshots", "balance, synced_at")] = snapshots or []


async def test_no_active_agreements_is_a_noop(fake_supabase):
    fake_supabase.select_responses[("prop_payout_agreements", "*")] = []

    await payout_detection.detect_withdrawal_events()

    assert fake_supabase.calls_for("broker_connections", "select") == []


async def test_first_snapshot_ever_just_records_no_event(fake_supabase, monkeypatch):
    _seed(fake_supabase, snapshots=[])
    client = _FakeMetaTraderClient(balance=1000.0)
    monkeypatch.setattr(payout_detection, "_build_client", lambda connection: client)

    await payout_detection.detect_withdrawal_events()

    snapshots = fake_supabase.calls_for("account_balance_snapshots", "insert")
    assert len(snapshots) == 1
    assert snapshots[0].values["balance"] == 1000.0
    assert fake_supabase.calls_for("withdrawal_events", "insert") == []


async def test_balance_increase_is_not_a_withdrawal(fake_supabase, monkeypatch):
    _seed(fake_supabase, snapshots=[{"balance": 900.0, "synced_at": "2026-01-01T00:00:00+00:00"}])
    client = _FakeMetaTraderClient(balance=1000.0)
    monkeypatch.setattr(payout_detection, "_build_client", lambda connection: client)

    await payout_detection.detect_withdrawal_events()

    assert fake_supabase.calls_for("withdrawal_events", "insert") == []


async def test_drop_fully_explained_by_trade_losses_is_ordinary_drawdown(fake_supabase, monkeypatch):
    _seed(fake_supabase, snapshots=[{"balance": 1000.0, "synced_at": "2026-01-01T00:00:00+00:00"}])
    # Balance dropped by 100, but a single -100 trade fully explains it.
    client = _FakeMetaTraderClient(balance=900.0, deals=[{"profit": -100.0}])
    monkeypatch.setattr(payout_detection, "_build_client", lambda connection: client)

    await payout_detection.detect_withdrawal_events()

    assert fake_supabase.calls_for("withdrawal_events", "insert") == []


async def test_clean_unexplained_drop_with_no_deals_is_auto_detected(fake_supabase, monkeypatch):
    _seed(fake_supabase, snapshots=[{"balance": 1000.0, "synced_at": "2026-01-01T00:00:00+00:00"}])
    client = _FakeMetaTraderClient(balance=500.0, deals=[])
    monkeypatch.setattr(payout_detection, "_build_client", lambda connection: client)

    await payout_detection.detect_withdrawal_events()

    events = fake_supabase.calls_for("withdrawal_events", "insert")
    assert len(events) == 1
    assert events[0].values["confidence"] == "auto_detected"
    assert events[0].values["detected_amount"] == 500.0

    rpc_calls = fake_supabase.rpc_calls
    assert len(rpc_calls) == 1
    assert rpc_calls[0].fn_name == "calculate_payout_split"


async def test_unexplained_drop_with_concurrent_trades_requires_manual_confirmation(fake_supabase, monkeypatch):
    _seed(fake_supabase, snapshots=[{"balance": 1000.0, "synced_at": "2026-01-01T00:00:00+00:00"}])
    # Drop of 500, only 50 explained by trade losses -> 450 unexplained,
    # but deals ARE present so it's ambiguous, not clean.
    client = _FakeMetaTraderClient(balance=500.0, deals=[{"profit": -50.0}, {"profit": 20.0}])
    monkeypatch.setattr(payout_detection, "_build_client", lambda connection: client)

    await payout_detection.detect_withdrawal_events()

    events = fake_supabase.calls_for("withdrawal_events", "insert")
    assert len(events) == 1
    assert events[0].values["confidence"] == "requires_manual_confirmation"
    assert fake_supabase.rpc_calls == []


async def test_non_metatrader_connection_is_skipped(fake_supabase, monkeypatch):
    _seed(fake_supabase, connections=[{**CONNECTION, "broker": "bybit"}])
    called = False

    def _should_not_be_called(connection):
        nonlocal called
        called = True
        return _FakeMetaTraderClient(balance=0.0)

    monkeypatch.setattr(payout_detection, "_build_client", _should_not_be_called)

    await payout_detection.detect_withdrawal_events()

    assert called is False
