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

METATRADER_CONNECTION = {
    "id": "conn-mt-1",
    "user_id": "user-1",
    "broker": "metatrader",
    "mt_login": "555666",
    "mt_server": "Exness-MT5Real8",
    "mt_platform": "mt5",
    "encrypted_mt_password": "ciphertext-mt-password",
    "mt_password_iv": "iv-mt-password",
    "metaapi_account_id": None,
    "metaapi_region": None,
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


def make_fake_metatrader_client(positions=None, provision_error: Exception | None = None):
    """A MetaTraderClient double. Its constructor deliberately does NOT
    match BrokerClient's (login/password/server/platform/metaapi_token
    instead of api_key/api_secret) — that's the point of the dedicated
    _build_metatrader_client() construction path being tested here.
    """

    class _FakeMetaTraderClient:
        aclose_called = False

        def __init__(self, login, password, server, platform, metaapi_token, account_id=None, region=None):
            self.login = login
            self.password = password
            self.server = server
            self.platform = platform
            self.metaapi_token = metaapi_token
            self.account_id = account_id
            self.region = region

        async def provision(self):
            if provision_error is not None:
                raise provision_error
            self.account_id = "provisioned-id"
            self.region = "provisioned-region"

        async def get_positions(self):
            return positions or []

        async def get_balance(self):
            return 0.0

        async def test_connection(self):
            return True

        async def aclose(self):
            type(self).aclose_called = True

    return _FakeMetaTraderClient


@pytest.fixture(autouse=True)
def no_real_decrypt(monkeypatch):
    # Threads the iv argument into the output (rather than discarding it)
    # so tests can assert the *correct, distinct* iv was used per field —
    # each credential field has its own iv column since the encryption_iv
    # reconciliation (see supabase/migrations/
    # 20260717000001_reconcile_remaining_tables_with_live.sql), and a test
    # that ignored iv here couldn't catch a bug that cross-wired
    # api_key_iv/api_secret_iv.
    monkeypatch.setattr(
        sync_service,
        "decrypt",
        lambda ciphertext, iv: f"decrypted:{ciphertext}:{iv}",
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
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
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


async def test_sync_connection_uses_each_credential_field_own_iv(monkeypatch, fake_supabase, fake_cache):
    """Regression guard for the encryption_iv reconciliation: api_key and
    api_secret must each be decrypted with their own iv column, never a
    shared or cross-wired one. CONNECTION fixture's key/secret ciphertexts
    and ivs are deliberately distinct ("ciphertext-key"/"iv-key" vs.
    "ciphertext-secret"/"iv-secret") specifically so a swap bug (e.g.
    passing api_secret_iv to decrypt the api key) would produce a visibly
    wrong value here rather than passing by coincidence.
    """
    captured = {}

    def _capturing_client(api_key, api_secret, api_passphrase=None):
        captured["api_key"] = api_key
        captured["api_secret"] = api_secret
        return make_fake_client(positions=[])(api_key, api_secret, api_passphrase)

    monkeypatch.setitem(sync_service.BROKER_CLIENTS, BrokerType.BYBIT, _capturing_client)
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(CONNECTION)

    assert captured["api_key"] == "decrypted:ciphertext-key:iv-key"
    assert captured["api_secret"] == "decrypted:ciphertext-secret:iv-secret"


async def test_sync_connection_metatrader_password_uses_its_own_iv(monkeypatch, fake_supabase, fake_cache):
    captured = {}

    def _capturing_metatrader_client(login, password, server, platform, metaapi_token, account_id=None, region=None):
        captured["password"] = password
        return make_fake_metatrader_client(positions=[])(
            login, password, server, platform, metaapi_token, account_id, region
        )

    monkeypatch.setattr(sync_service, "MetaTraderClient", _capturing_metatrader_client)
    monkeypatch.setattr(sync_service.settings, "metaapi_token", "fake-metaapi-token")
    connection = {**METATRADER_CONNECTION, "metaapi_account_id": "already-provisioned", "metaapi_region": "london"}
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(connection)

    assert captured["password"] == "decrypted:ciphertext-mt-password:iv-mt-password"


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
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = [
        {"id": "still-open", "symbol": "ETHUSDT", "side": "short", "synced_at": "2026-07-19T00:00:00+00:00"},
        {"id": "closed-now", "symbol": "BTCUSDT", "side": "long", "synced_at": "2026-07-19T00:00:00+00:00"},
    ]
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]
    # No signal_actions on file for either symbol in this test — outcome
    # detection (app/signal_outcomes.py) must no-op cleanly rather than
    # error when a closed position was never a Signal Mode/Managed Mode
    # trade to begin with.
    fake_supabase.select_responses[("signal_actions", "id, signal_id, executed_size")] = []

    await sync_service.sync_connection(CONNECTION)

    deletes = fake_supabase.calls_for("positions", "delete")
    assert len(deletes) == 1
    assert deletes[0].filters == [("in_", "id", ["closed-now"])]

    # A snapshot already exists for today — must not be touched again.
    assert fake_supabase.calls_for("portfolio_snapshots", "insert") == []
    # BTCUSDT/long had no matching signal_actions — nothing recorded.
    assert fake_supabase.calls_for("signal_outcomes", "insert") == []


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
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
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
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(connection)

    assert captured_passphrase["value"] == "decrypted:ciphertext-passphrase:iv-passphrase"

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


async def test_sync_connection_provisions_metatrader_on_first_sync(monkeypatch, fake_supabase, fake_cache):
    monkeypatch.setattr(sync_service.settings, "metaapi_token", "test-metaapi-token")
    position = Position(
        symbol="EURUSD",
        side="long",
        size=50000,
        entry_price=1.1,
        mark_price=1.105,
        broker_source=BrokerType.METATRADER,
    )
    monkeypatch.setattr(sync_service, "MetaTraderClient", make_fake_metatrader_client(positions=[position]))
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(METATRADER_CONNECTION)

    updates = fake_supabase.calls_for("broker_connections", "update")
    # The provisioning result is persisted...
    assert any(
        u.values.get("metaapi_account_id") == "provisioned-id"
        and u.values.get("metaapi_region") == "provisioned-region"
        for u in updates
    )
    # ...and the sync itself still completes normally afterward.
    assert any(u.values.get("sync_status") == "connected" for u in updates)

    upserts = fake_supabase.calls_for("positions", "upsert")
    assert len(upserts) == 1
    assert upserts[0].rows[0]["symbol"] == "EURUSD"


async def test_sync_connection_skips_provisioning_when_already_provisioned(
    monkeypatch, fake_supabase, fake_cache
):
    monkeypatch.setattr(sync_service.settings, "metaapi_token", "test-metaapi-token")

    async def _provision_should_not_be_called(self):
        raise AssertionError("provision() must not be called when account_id/region are already set")

    client_cls = make_fake_metatrader_client()
    client_cls.provision = _provision_should_not_be_called
    monkeypatch.setattr(sync_service, "MetaTraderClient", client_cls)

    connection = {**METATRADER_CONNECTION, "metaapi_account_id": "existing-id", "metaapi_region": "london"}
    fake_supabase.select_responses[("positions", "id, symbol, side, synced_at")] = []
    fake_supabase.select_responses[("portfolio_snapshots", "id")] = [{"id": "already-exists"}]

    await sync_service.sync_connection(connection)

    updates = fake_supabase.calls_for("broker_connections", "update")
    assert all("metaapi_account_id" not in u.values for u in updates)
    assert any(u.values.get("sync_status") == "connected" for u in updates)


async def test_sync_connection_marks_error_when_metaapi_token_not_configured(
    monkeypatch, fake_supabase, fake_cache
):
    monkeypatch.setattr(sync_service.settings, "metaapi_token", None)

    await sync_service.sync_connection(METATRADER_CONNECTION)

    assert fake_supabase.calls_for("positions") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "error"
    assert "not configured" in connection_updates[0].values["last_error"]


async def test_sync_connection_marks_error_when_metatrader_provisioning_fails(
    monkeypatch, fake_supabase, fake_cache
):
    monkeypatch.setattr(sync_service.settings, "metaapi_token", "test-metaapi-token")
    monkeypatch.setattr(
        sync_service,
        "MetaTraderClient",
        make_fake_metatrader_client(
            provision_error=RuntimeError(
                "MetaApi account creation failed (403): To allow trading account deployment please top up your account."
            )
        ),
    )

    await sync_service.sync_connection(METATRADER_CONNECTION)

    assert fake_supabase.calls_for("positions") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "error"
    assert "top up your account" in connection_updates[0].values["last_error"]
    # A failed provision must never leave a partial account_id/region
    # written — the row stays exactly as unprovisioned as it started.
    assert "metaapi_account_id" not in connection_updates[0].values


async def test_sync_connection_marks_error_on_mt_password_decrypt_failure(
    monkeypatch, fake_supabase, fake_cache
):
    monkeypatch.setattr(sync_service.settings, "metaapi_token", "test-metaapi-token")

    def _raise(*args, **kwargs):
        raise ValueError("bad ciphertext")

    monkeypatch.setattr(sync_service, "decrypt", _raise)

    await sync_service.sync_connection(METATRADER_CONNECTION)

    assert fake_supabase.calls_for("positions") == []
    assert fake_cache == []

    connection_updates = fake_supabase.calls_for("broker_connections", "update")
    assert len(connection_updates) == 1
    assert connection_updates[0].values["sync_status"] == "error"
    assert connection_updates[0].values["last_error"] == "Could not decrypt stored credentials."


async def test_sync_connection_skips_unregistered_broker(monkeypatch, fake_supabase, fake_cache):
    # All four BrokerType members are registered today, so simulate the
    # "valid enum member, no BROKER_CLIENTS entry yet" state directly —
    # the branch this test targets is distinct from an unknown-string
    # broker (covered by test_sync_connection_skips_unknown_broker_string).
    monkeypatch.delitem(sync_service.BROKER_CLIENTS, BrokerType.BYBIT)

    await sync_service.sync_connection(CONNECTION)

    assert fake_supabase.calls == []
    assert fake_cache == []


async def test_sync_connection_skips_unknown_broker_string(fake_supabase, fake_cache):
    connection = {**CONNECTION, "broker": "hantec"}

    await sync_service.sync_connection(connection)

    assert fake_supabase.calls == []
    assert fake_cache == []
