import pytest

from app import sync_service
from app.brokers.base import BrokerClient
from app.models import BrokerType, Position
from tests.conftest import FakeSupabase

CONNECTION = {
    "id": "conn-1",
    "user_id": "user-1",
    "broker": "bybit",
    "encrypted_api_key": "ciphertext-key",
    "api_key_iv": "iv-key",
    "encrypted_api_secret": "ciphertext-secret",
    "api_secret_iv": "iv-secret",
}


def make_fake_client(positions=None, error: Exception | None = None):
    """A BrokerClient double whose get_positions() either returns a fixed
    list or raises — lets tests drive sync_connection's branches without
    touching real HTTP or real encryption.
    """

    class _FakeClient(BrokerClient):
        aclose_called = False

        def __init__(self, api_key: str, api_secret: str, api_passphrase: str | None = None):
            self.api_key = api_key
            self.api_secret = api_secret
            self.api_passphrase = api_passphrase

        async def get_positions(self):
            if error is not None:
                raise error
            return positions or []

        async def get_balance(self):
            return 0.0

        async def test_connection(self):
            return True

        async def aclose(self):
            type(self).aclose_called = True

    return _FakeClient


@pytest.fixture(autouse=True)
def no_real_decrypt(monkeypatch):
    monkeypatch.setattr(
        sync_service,
        "decrypt",
        lambda ciphertext, iv: f"decrypted:{ciphertext}",
    )


@pytest.fixture
def fake_cache(monkeypatch):
    calls = []

    async def _cache_positions(connection_id, rows):
        calls.append((connection_id, rows))

    monkeypatch.setattr(sync_service, "cache_positions", _cache_positions)
    return calls


@pytest.fixture
def fake_supabase(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(sync_service, "get_service_client", lambda: supabase)
    return supabase


async def test_sync_connection_normalizes_caches_and_upserts(monkeypatch, fake_supabase, fake_cache):
    position = Position(
        symbol="ETHUSDT",
        side="short",
        size=2,
        entry_price=3000,
        mark_price=2900,
        leverage=5,
        unrealized_pnl=200,
        unrealized_pnl_pct=3.33,
        margin_used=1200,
        broker_source=BrokerType.BYBIT,
    )
    monkeypatch.setitem(
        sync_service.BROKER_CLIENTS, BrokerType.BYBIT, make_fake_client(positions=[position])
    )
    # No stale rows and no snapshot yet, so both branches run to completion.
    fake_supabase.select_responses[("positions", "id, symbol, side")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = []
    fake_supabase.select_responses[
        ("positions", "size, mark_price, entry_price, broker_connections(broker)")
    ] = []
    fake_supabase.select_responses[("manual_assets", "value")] = []

    await sync_service.sync_connection(CONNECTION)

    assert len(fake_cache) == 1
    cached_connection_id, cached_rows = fake_cache[0]
    assert cached_connection_id == "conn-1"
    assert cached_rows == [
        {
            "user_id": "user-1",
            "broker_connection_id": "conn-1",
            "symbol": "ETHUSDT",
            "side": "short",
            "size": 2,
            "entry_price": 3000,
            "mark_price": 2900,
            "leverage": 5,
            "unrealized_pnl": 200,
            "unrealized_pnl_pct": 3.33,
            "margin_used": 1200,
        }
    ]

    upserts = fake_supabase.calls_for("positions", "upsert")
    assert len(upserts) == 1
    assert upserts[0].rows == cached_rows
    assert upserts[0].on_conflict == "broker_connection_id,symbol,side"

    # Nothing existed to delete.
    assert fake_supabase.calls_for("positions", "delete") == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "connected"
    assert connection_updates[0].values["last_error"] is None
    assert connection_updates[0].values["last_synced_at"] is not None

    assert len(fake_supabase.calls_for("portfolio_snapshots", "insert")) == 1


async def test_sync_connection_deletes_only_stale_positions(monkeypatch, fake_supabase, fake_cache):
    position = Position(
        symbol="ETHUSDT",
        side="short",
        size=2,
        entry_price=3000,
        mark_price=2900,
        broker_source=BrokerType.BYBIT,
    )
    monkeypatch.setitem(
        sync_service.BROKER_CLIENTS, BrokerType.BYBIT, make_fake_client(positions=[position])
    )
    fake_supabase.select_responses[("positions", "id, symbol, side")] = [
        {"id": "still-open", "symbol": "ETHUSDT", "side": "short"},
        {"id": "closed-now", "symbol": "BTCUSDT", "side": "long"},
    ]
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(CONNECTION)

    deletes = fake_supabase.calls_for("positions", "delete")
    assert len(deletes) == 1
    assert deletes[0].filters == [("in_", "id", ["closed-now"])]

    # A snapshot already exists for today — must not be touched again.
    assert fake_supabase.calls_for("portfolio_snapshots", "insert") == []


async def test_sync_connection_keeps_stale_data_on_broker_failure(monkeypatch, fake_supabase, fake_cache):
    monkeypatch.setitem(
        sync_service.BROKER_CLIENTS,
        BrokerType.BYBIT,
        make_fake_client(error=RuntimeError("Bybit API rate limit exceeded after retries.")),
    )

    await sync_service.sync_connection(CONNECTION)

    # Nothing about positions or the snapshot was ever touched.
    assert fake_supabase.calls_for("positions") == []
    assert fake_supabase.calls_for("portfolio_snapshots") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values == {
        "sync_status": "error",
        "last_error": "Bybit API rate limit exceeded after retries.",
    }
    # Critically: last_synced_at is absent, not overwritten with a fresh
    # timestamp — the "Last updated" badge must keep reflecting the last
    # time data actually changed, not the last time we merely tried.
    assert "last_synced_at" not in connection_updates[0].values


async def test_sync_connection_keeps_stale_data_on_decrypt_failure(monkeypatch, fake_supabase, fake_cache):
    def _raise(*args, **kwargs):
        raise ValueError("bad ciphertext")

    monkeypatch.setattr(sync_service, "decrypt", _raise)

    await sync_service.sync_connection(CONNECTION)

    assert fake_supabase.calls_for("positions") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "error"
    assert connection_updates[0].values["last_error"] == "Could not decrypt stored credentials."


async def test_sync_connection_routes_binance_connections_to_binance_client(
    monkeypatch, fake_supabase, fake_cache
):
    position = Position(
        symbol="BTCUSDT",
        side="long",
        size=0.5,
        entry_price=60000,
        mark_price=61200,
        broker_source=BrokerType.BINANCE,
    )
    monkeypatch.setitem(
        sync_service.BROKER_CLIENTS, BrokerType.BINANCE, make_fake_client(positions=[position])
    )
    connection = {**CONNECTION, "broker": "binance"}
    fake_supabase.select_responses[("positions", "id, symbol, side")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(connection)

    upserts = fake_supabase.calls_for("positions", "upsert")
    assert len(upserts) == 1
    assert upserts[0].rows[0]["symbol"] == "BTCUSDT"

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert connection_updates[0].values["sync_status"] == "connected"


async def test_sync_connection_routes_kucoin_connections_and_decrypts_passphrase(
    monkeypatch, fake_supabase, fake_cache
):
    position = Position(
        symbol="XBTUSDTM",
        side="long",
        size=1,
        entry_price=60000,
        mark_price=61200,
        broker_source=BrokerType.KUCOIN,
    )
    captured_passphrase = {}

    def _fake_kucoin_client(api_key, api_secret, api_passphrase=None):
        captured_passphrase["value"] = api_passphrase
        return make_fake_client(positions=[position])(api_key, api_secret, api_passphrase)

    monkeypatch.setitem(sync_service.BROKER_CLIENTS, BrokerType.KUCOIN, _fake_kucoin_client)
    connection = {
        **CONNECTION,
        "broker": "kucoin",
        "encrypted_api_passphrase": "ciphertext-passphrase",
        "api_passphrase_iv": "iv-passphrase",
    }
    fake_supabase.select_responses[("positions", "id, symbol, side")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(connection)

    assert captured_passphrase["value"] == "decrypted:ciphertext-passphrase"

    upserts = fake_supabase.calls_for("positions", "upsert")
    assert len(upserts) == 1
    assert upserts[0].rows[0]["symbol"] == "XBTUSDTM"

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert connection_updates[0].values["sync_status"] == "connected"


async def test_sync_connection_marks_error_when_kucoin_client_construction_fails(
    monkeypatch, fake_supabase, fake_cache
):
    def _raising_client(api_key, api_secret, api_passphrase=None):
        raise ValueError("KucoinClient requires api_passphrase")

    monkeypatch.setitem(sync_service.BROKER_CLIENTS, BrokerType.KUCOIN, _raising_client)
    # No encrypted_api_passphrase on this row — decrypt is skipped, so
    # api_passphrase stays None and client construction is what fails.
    connection = {**CONNECTION, "broker": "kucoin"}

    await sync_service.sync_connection(connection)

    assert fake_supabase.calls_for("positions") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "error"
    assert "api_passphrase" in connection_updates[0].values["last_error"]


async def test_sync_connection_skips_unregistered_broker(fake_supabase, fake_cache):
    # 'metatrader' is a valid BrokerType member but has no BROKER_CLIENTS
    # entry yet — the branch this test targets is distinct from an
    # unknown-string broker (covered by test_sync_connection_skips_unknown_broker_string).
    connection = {**CONNECTION, "broker": "metatrader"}

    await sync_service.sync_connection(connection)

    assert fake_supabase.calls == []
    assert fake_cache == []


async def test_sync_connection_skips_unknown_broker_string(fake_supabase, fake_cache):
    connection = {**CONNECTION, "broker": "hantec"}

    await sync_service.sync_connection(connection)

    assert fake_supabase.calls == []
    assert fake_cache == []
