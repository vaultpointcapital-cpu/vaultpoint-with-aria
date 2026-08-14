import pytest

from app import signal_execution
from app.config import settings
from app.signal_execution import SignalExecutionError, execute_signal
from tests.conftest import FakeSupabase

CONNECTION = {
    "id": "conn-1",
    "user_id": "user-1",
    "broker": "bybit",
    "trade_execution_enabled": True,
    "encrypted_api_key": "ciphertext-key",
    "api_key_iv": "iv-key",
    "encrypted_api_secret": "ciphertext-secret",
    "api_secret_iv": "iv-secret",
}

METATRADER_CONNECTION = {
    "id": "conn-mt-1",
    "user_id": "user-1",
    "broker": "metatrader",
    "trade_execution_enabled": True,
    "mt_login": "555666",
    "mt_server": "Exness-MT5Real8",
    "mt_platform": "mt5",
    "encrypted_mt_password": "ciphertext-mt-password",
    "mt_password_iv": "iv-mt-password",
    "metaapi_account_id": "acct-1",
    "metaapi_region": "london",
}

SIGNAL = {
    "id": "signal-1",
    "pair": "BTCUSDT",
    "direction": "long",
    "entry_price": 65000,
    "stop_loss": 63000,
    "take_profit": 70000,
    "status": "active",
}


def _supabase_with(connection=None, signal=SIGNAL) -> FakeSupabase:
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = [connection] if connection else []
    supabase.select_responses[("signals", "*")] = [signal] if signal else []
    return supabase


@pytest.fixture(autouse=True)
def no_real_decrypt(monkeypatch):
    monkeypatch.setattr(signal_execution, "decrypt", lambda ciphertext, iv: f"decrypted:{ciphertext}:{iv}")


def make_fake_bybit_client(order_id="order-123", error: Exception | None = None):
    calls = []

    class _FakeBybitClient:
        def __init__(self, api_key, api_secret):
            calls.append((api_key, api_secret))

        async def place_order(self, **kwargs):
            calls.append(kwargs)
            if error is not None:
                raise error
            return order_id

        async def aclose(self):
            calls.append("closed")

    return _FakeBybitClient, calls


def make_fake_metatrader_client(order_id="mt-order-1", error: Exception | None = None):
    calls = []

    class _FakeMetaTraderClient:
        def __init__(self, **kwargs):
            calls.append(kwargs)

        async def place_order(self, **kwargs):
            calls.append(kwargs)
            if error is not None:
                raise error
            return order_id

        async def aclose(self):
            calls.append("closed")

    return _FakeMetaTraderClient, calls


async def test_raises_when_connection_not_found(monkeypatch):
    supabase = _supabase_with(connection=None)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="Broker connection not found"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_raises_when_connection_not_trade_enabled(monkeypatch):
    connection = {**CONNECTION, "trade_execution_enabled": False}
    supabase = _supabase_with(connection=connection)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="not authorized for trade execution"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_raises_for_unsupported_broker(monkeypatch):
    connection = {**CONNECTION, "broker": "binance"}
    supabase = _supabase_with(connection=connection)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="not supported for broker=binance"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_raises_when_signal_not_found(monkeypatch):
    supabase = _supabase_with(connection=CONNECTION, signal=None)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="Signal not found"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_raises_when_signal_not_active(monkeypatch):
    closed_signal = {**SIGNAL, "status": "closed"}
    supabase = _supabase_with(connection=CONNECTION, signal=closed_signal)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="no longer active"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_executes_via_bybit_with_decrypted_credentials(monkeypatch):
    supabase = _supabase_with(connection=CONNECTION)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    fake_client_cls, calls = make_fake_bybit_client(order_id="order-999")
    monkeypatch.setattr(signal_execution, "BybitClient", fake_client_cls)

    order_id = await execute_signal(
        user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
    )

    assert order_id == "order-999"
    assert calls[0] == ("decrypted:ciphertext-key:iv-key", "decrypted:ciphertext-secret:iv-secret")
    place_order_call = calls[1]
    assert place_order_call["symbol"] == "BTCUSDT"
    assert place_order_call["side"] == "long"
    assert place_order_call["qty"] == 0.01
    assert place_order_call["entry_price"] == 65000
    assert place_order_call["stop_loss"] == 63000
    assert place_order_call["take_profit"] == 70000
    assert place_order_call["order_link_id"] == "sig-signal-1"
    assert calls[2] == "closed"  # client is always closed, even on success


async def test_executes_via_metatrader_with_decrypted_credentials(monkeypatch):
    monkeypatch.setattr(settings, "metaapi_token", "test-metaapi-token")
    supabase = _supabase_with(connection=METATRADER_CONNECTION)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    fake_client_cls, calls = make_fake_metatrader_client(order_id="mt-order-42")
    monkeypatch.setattr(signal_execution, "MetaTraderClient", fake_client_cls)

    order_id = await execute_signal(
        user_id="user-1", signal_id="signal-1", broker_connection_id="conn-mt-1", size=0.5
    )

    assert order_id == "mt-order-42"
    init_kwargs = calls[0]
    assert init_kwargs["login"] == "555666"
    assert init_kwargs["password"] == "decrypted:ciphertext-mt-password:iv-mt-password"
    assert init_kwargs["server"] == "Exness-MT5Real8"
    assert init_kwargs["platform"] == "mt5"
    assert init_kwargs["metaapi_token"] == "test-metaapi-token"
    assert init_kwargs["account_id"] == "acct-1"
    assert init_kwargs["region"] == "london"

    place_order_call = calls[1]
    assert place_order_call["symbol"] == "BTCUSDT"
    assert place_order_call["side"] == "long"
    assert place_order_call["volume"] == 0.5
    assert calls[2] == "closed"


async def test_metatrader_raises_when_metaapi_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "metaapi_token", None)
    supabase = _supabase_with(connection=METATRADER_CONNECTION)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="not configured on this server"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-mt-1", size=0.5
        )


async def test_metatrader_raises_when_connection_never_synced(monkeypatch):
    monkeypatch.setattr(settings, "metaapi_token", "test-metaapi-token")
    unsynced_connection = {**METATRADER_CONNECTION, "metaapi_account_id": None, "metaapi_region": None}
    supabase = _supabase_with(connection=unsynced_connection)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    with pytest.raises(SignalExecutionError, match="has not completed its first sync"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-mt-1", size=0.5
        )


async def test_wraps_broker_exception_as_signal_execution_error(monkeypatch):
    supabase = _supabase_with(connection=CONNECTION)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    fake_client_cls, _calls = make_fake_bybit_client(error=RuntimeError("insufficient balance"))
    monkeypatch.setattr(signal_execution, "BybitClient", fake_client_cls)

    with pytest.raises(SignalExecutionError, match="insufficient balance"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )


async def test_does_not_double_wrap_signal_execution_error(monkeypatch):
    # _execute_bybit itself never raises SignalExecutionError directly
    # today, but execute_signal's outer try/except re-raises
    # SignalExecutionError as-is rather than wrapping it in another one —
    # this guards that re-raise path so a future broker-side validation
    # error keeps its original, specific message instead of being
    # flattened to str(exc).
    supabase = _supabase_with(connection=CONNECTION)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)

    fake_client_cls, _calls = make_fake_bybit_client(
        error=SignalExecutionError("a very specific broker validation failure")
    )
    monkeypatch.setattr(signal_execution, "BybitClient", fake_client_cls)

    with pytest.raises(SignalExecutionError, match="^a very specific broker validation failure$"):
        await execute_signal(
            user_id="user-1", signal_id="signal-1", broker_connection_id="conn-1", size=0.01
        )
