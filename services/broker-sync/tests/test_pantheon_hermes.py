import pytest

from app.pantheon import hermes
from tests.conftest import FakeSupabase


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Same network-free double test_connection_health_notifications.py
    uses for httpx.AsyncClient — no real CoinGecko call is ever made."""

    payload: list = []
    captured_calls: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, params=None):
        _FakeAsyncClient.captured_calls.append({"url": url, "params": params})
        return _FakeResponse(_FakeAsyncClient.payload)


def coingecko_row(coingecko_id, *, change=15.0, volume=200_000_000.0, price=50000.0):
    return {
        "id": coingecko_id,
        "price_change_percentage_24h": change,
        "total_volume": volume,
        "current_price": price,
    }


@pytest.fixture(autouse=True)
def reset_fake_client():
    _FakeAsyncClient.captured_calls = []
    _FakeAsyncClient.payload = []


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(hermes, "get_service_client", lambda: fake)
    monkeypatch.setattr(hermes.httpx, "AsyncClient", _FakeAsyncClient)
    return fake


def _configure_baseline(fake: FakeSupabase, user_ids=("user-1",)) -> None:
    fake.select_responses[("broker_connections", "user_id")] = [{"user_id": uid} for uid in user_ids]
    fake.select_responses[("positions", "*")] = []
    fake.select_responses[("manual_assets", "value, currency")] = []
    fake.select_responses[("portfolio_snapshots", "total_net_worth, snapshot_date")] = []
    fake.select_responses[("positions", "symbol")] = []
    fake.select_responses[("aria_findings", "id, status, delivered_at")] = []


async def test_writes_a_buy_signal_for_a_qualifying_mover(fake_supabase):
    _configure_baseline(fake_supabase)
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=15.0, volume=200_000_000.0)]

    await hermes.run_hermes_scan()

    inserts = fake_supabase.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["dedup_key"] == "hermes:buy_signal:BTC:caution"
    assert inserts[0].values["severity"] == "caution"


async def test_skips_movers_below_the_move_threshold(fake_supabase):
    _configure_baseline(fake_supabase)
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=3.0, volume=200_000_000.0)]

    await hermes.run_hermes_scan()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_skips_movers_below_the_volume_threshold(fake_supabase):
    _configure_baseline(fake_supabase)
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=15.0, volume=1_000_000.0)]

    await hermes.run_hermes_scan()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_skips_negative_moves(fake_supabase):
    _configure_baseline(fake_supabase)
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=-20.0, volume=200_000_000.0)]

    await hermes.run_hermes_scan()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_skips_a_symbol_the_user_already_holds(fake_supabase):
    _configure_baseline(fake_supabase)
    fake_supabase.select_responses[("positions", "symbol")] = [{"symbol": "BTC"}]
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=15.0, volume=200_000_000.0)]

    await hermes.run_hermes_scan()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_skips_users_in_cool_down(fake_supabase):
    _configure_baseline(fake_supabase)
    # Current net worth 40,000 (via positions "*"), yesterday's snapshot
    # 100,000 -> a 60% single-day drop, well past the 10% cool-down
    # threshold mirrored from src/lib/aria/compliance.ts.
    fake_supabase.select_responses[("positions", "*")] = [
        {"id": "pos-1", "size": 1, "entry_price": 50000, "mark_price": 40000, "currency": "USD"}
    ]
    fake_supabase.select_responses[("portfolio_snapshots", "total_net_worth, snapshot_date")] = [
        {"total_net_worth": 100000, "snapshot_date": "2026-08-10"}
    ]
    _FakeAsyncClient.payload = [coingecko_row("bitcoin", change=15.0, volume=200_000_000.0)]

    await hermes.run_hermes_scan()

    assert fake_supabase.calls_for("aria_findings", "insert") == []


async def test_expires_stale_new_buy_signal_findings_at_the_start_of_each_run(fake_supabase):
    _configure_baseline(fake_supabase)
    _FakeAsyncClient.payload = []

    await hermes.run_hermes_scan()

    updates = fake_supabase.calls_for("aria_findings", "update")
    assert len(updates) == 1
    assert updates[0].values == {"status": "expired"}
    assert ("eq", "source_agent", "hermes") in updates[0].filters
    assert ("eq", "finding_type", "buy_signal") in updates[0].filters
