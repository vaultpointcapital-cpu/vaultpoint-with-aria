import pytest

from app import managed_mode, signal_execution
from app.config import settings
from app.managed_mode import evaluate_managed_mode
from tests.conftest import FakeSupabase

CONNECTION = {
    "id": "conn-1",
    "user_id": "user-1",
    "broker": "bybit",
    "trade_execution_enabled": True,
    "managed_mode_enabled": True,
    "managed_mode_risk_pct": 1.0,
    "managed_mode_daily_loss_limit_pct": 5.0,
    "encrypted_api_key": "ciphertext-key",
    "api_key_iv": "iv-key",
    "encrypted_api_secret": "ciphertext-secret",
    "api_secret_iv": "iv-secret",
}

MT_CONNECTION = {
    **CONNECTION,
    "id": "conn-mt-1",
    "broker": "metatrader",
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
    "min_tier": "elite",
    "status": "active",
    "confidence": "high",
}


def _supabase_with(
    connections=None,
    tier="elite",
    signals=None,
    aria_action_ids=None,
    outcomes=None,
    prior_actions=None,
    still_enabled=True,
) -> FakeSupabase:
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = connections if connections is not None else [CONNECTION]
    supabase.select_responses[("users", "subscription_tier")] = [{"subscription_tier": tier}] if tier else []
    supabase.select_responses[("signals", "*")] = signals if signals is not None else [SIGNAL]
    supabase.select_responses[("signal_actions", "id")] = (
        [{"id": aid} for aid in aria_action_ids] if aria_action_ids else []
    )
    supabase.select_responses[("signal_outcomes", "realized_pnl")] = outcomes or []
    supabase.select_responses[("signal_actions", "signal_id")] = (
        [{"signal_id": sid} for sid in prior_actions] if prior_actions else []
    )
    # _attempt_execution's own fresh re-check, immediately before placing
    # an order — defaults to still enabled so every test not specifically
    # about this race doesn't need to configure it.
    supabase.select_responses[("broker_connections", "managed_mode_enabled")] = [
        {"managed_mode_enabled": still_enabled}
    ]
    return supabase


def _patch_supabase(monkeypatch, supabase: FakeSupabase) -> None:
    """execute_signal() (signal_execution.py) does its own
    get_service_client() lookup via that module's own imported
    reference — a distinct name binding from managed_mode.py's, even
    though both originally point at the same factory function. Both
    must be patched to the same fake instance or execute_signal's
    internal connection/signal lookups hit a real (or unconfigured)
    client instead of this test's fixtures.
    """
    monkeypatch.setattr(managed_mode, "get_service_client", lambda: supabase)
    monkeypatch.setattr(signal_execution, "get_service_client", lambda: supabase)


@pytest.fixture(autouse=True)
def no_real_decrypt(monkeypatch):
    fake_decrypt = lambda ciphertext, iv: f"decrypted:{ciphertext}:{iv}"  # noqa: E731
    monkeypatch.setattr(managed_mode, "decrypt", fake_decrypt)
    # execute_signal() (called by managed_mode._attempt_execution) does its
    # own decrypt inside signal_execution.py, via that module's own
    # imported reference — a distinct name binding from managed_mode's,
    # even though both originally point at the same function.
    monkeypatch.setattr(signal_execution, "decrypt", fake_decrypt)


def patch_bybit_client(monkeypatch, balance=10000.0, order_id="order-1", error: Exception | None = None):
    """Patches the BybitClient reference in BOTH managed_mode.py (used for
    the kill-switch/equity reads) AND signal_execution.py (used inside
    execute_signal(), which managed_mode._attempt_execution calls for the
    actual order placement) — these are separate name bindings in two
    modules, so patching only one leaves the other constructing a real
    client. Both point at the same fake class/call log so a test can
    assert on the whole sequence in one place.
    """
    calls = []

    class _FakeBybitClient:
        def __init__(self, api_key, api_secret):
            calls.append(("init", api_key, api_secret))

        async def get_balance(self):
            calls.append(("get_balance",))
            return balance

        async def place_order(self, **kwargs):
            calls.append(("place_order", kwargs))
            if error is not None:
                raise error
            return order_id

        async def aclose(self):
            calls.append(("aclose",))

    monkeypatch.setattr(managed_mode, "BybitClient", _FakeBybitClient)
    monkeypatch.setattr(signal_execution, "BybitClient", _FakeBybitClient)
    return calls


def patch_metatrader_client(monkeypatch, balance=10000.0, order_id="mt-order-1", contract_sizes=None):
    calls = []
    sizes = contract_sizes or {}

    class _FakeMetaTraderClient:
        def __init__(self, **kwargs):
            calls.append(("init", kwargs))

        async def get_balance(self):
            calls.append(("get_balance",))
            return balance

        async def _get_symbol_contract_sizes(self, symbols):
            calls.append(("contract_sizes", symbols))
            return sizes

        async def place_order(self, **kwargs):
            calls.append(("place_order", kwargs))
            return order_id

        async def aclose(self):
            calls.append(("aclose",))

    monkeypatch.setattr(managed_mode, "MetaTraderClient", _FakeMetaTraderClient)
    monkeypatch.setattr(signal_execution, "MetaTraderClient", _FakeMetaTraderClient)
    return calls


async def test_skips_connections_with_managed_mode_disabled(monkeypatch):
    supabase = _supabase_with(connections=[])
    _patch_supabase(monkeypatch, supabase)

    await evaluate_managed_mode()

    # select_responses keyed by ("broker_connections", "*") returning []
    # means nothing further should have been queried at all.
    assert supabase.calls_for("users") == []


async def test_disables_managed_mode_for_non_elite_user(monkeypatch):
    supabase = _supabase_with(tier="pro")
    _patch_supabase(monkeypatch, supabase)
    calls = patch_bybit_client(monkeypatch)

    await evaluate_managed_mode()

    updates = supabase.calls_for("broker_connections", "update")
    assert len(updates) == 1
    assert updates[0].values == {"managed_mode_enabled": False}
    # Never got as far as touching the broker.
    assert calls == []


async def test_disables_managed_mode_when_daily_loss_limit_breached(monkeypatch):
    supabase = _supabase_with(
        aria_action_ids=["action-1", "action-2"],
        outcomes=[{"realized_pnl": -400.0}, {"realized_pnl": -100.0}],
    )
    _patch_supabase(monkeypatch, supabase)
    # -500 loss / 10000 equity = 5% loss, equal to managed_mode_daily_loss_limit_pct (5.0) -> tripped.
    patch_bybit_client(monkeypatch, balance=10000.0)

    await evaluate_managed_mode()

    updates = supabase.calls_for("broker_connections", "update")
    assert len(updates) == 1
    assert updates[0].values == {"managed_mode_enabled": False}
    # No signal_actions insert attempted — kill switch stopped it before sizing.
    assert supabase.calls_for("signal_actions", "insert") == []


async def test_does_not_trip_kill_switch_on_profitable_day(monkeypatch):
    supabase = _supabase_with(
        aria_action_ids=["action-1"],
        outcomes=[{"realized_pnl": 200.0}],
        prior_actions=[],
    )
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch, balance=10000.0, order_id="order-999")

    await evaluate_managed_mode()

    updates = supabase.calls_for("broker_connections", "update")
    assert updates == []  # never disabled
    inserts = supabase.calls_for("signal_actions", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["action"] == "executed"


async def test_does_not_trip_kill_switch_with_no_prior_aria_trades(monkeypatch):
    supabase = _supabase_with(aria_action_ids=[])
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch, balance=10000.0)

    await evaluate_managed_mode()

    assert supabase.calls_for("broker_connections", "update") == []


async def test_skips_low_confidence_signals(monkeypatch):
    low_confidence_signal = {**SIGNAL, "confidence": "low"}
    supabase = _supabase_with(signals=[low_confidence_signal])
    _patch_supabase(monkeypatch, supabase)
    calls = patch_bybit_client(monkeypatch)

    await evaluate_managed_mode()

    assert supabase.calls_for("signal_actions", "insert") == []
    # Balance was never even read since there was nothing eligible to size.
    assert calls == []


async def test_skips_signals_already_terminally_acted_on(monkeypatch):
    supabase = _supabase_with(prior_actions=["signal-1"])
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch)

    await evaluate_managed_mode()

    assert supabase.calls_for("signal_actions", "insert") == []


async def test_retries_signal_with_only_prior_failed_actions(monkeypatch):
    # _fetch_eligible_signals excludes action='failed' rows specifically
    # (matching the DB's own partial-unique-index semantics — a failed
    # attempt never blocks a retry).
    supabase = _supabase_with()
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch, order_id="order-42")

    await evaluate_managed_mode()

    # Two distinct signal_actions selects happen per cycle (the kill-switch
    # check's id-select, then this fetch's signal_id-select) — find the
    # one this test actually cares about by its columns, not by position.
    action_query = next(
        c for c in supabase.calls_for("signal_actions", "select") if c.columns == "signal_id"
    )
    assert ("neq", "action", "failed") in action_query.filters

    inserts = supabase.calls_for("signal_actions", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["action"] == "executed"


async def test_computes_risk_based_position_size_for_bybit(monkeypatch):
    supabase = _supabase_with()
    _patch_supabase(monkeypatch, supabase)
    calls = patch_bybit_client(monkeypatch, balance=10000.0, order_id="order-1")

    await evaluate_managed_mode()

    # risk_amount = 10000 * 1% = 100; stop_distance = |65000-63000| = 2000
    # size = 100 / 2000 = 0.05
    place_order_call = next(c for c in calls if c[0] == "place_order")[1]
    assert place_order_call["qty"] == pytest.approx(0.05)

    inserts = supabase.calls_for("signal_actions", "insert")
    assert inserts[0].values["executed_size"] == pytest.approx(0.05)
    assert inserts[0].values["initiated_by"] == "aria"
    assert inserts[0].values["broker_order_id"] == "order-1"


async def test_skips_signal_with_zero_stop_distance(monkeypatch):
    bad_signal = {**SIGNAL, "entry_price": 65000, "stop_loss": 65000}
    supabase = _supabase_with(signals=[bad_signal])
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch)

    await evaluate_managed_mode()

    assert supabase.calls_for("signal_actions", "insert") == []


async def test_records_failed_action_with_aria_initiator_on_broker_rejection(monkeypatch):
    supabase = _supabase_with()
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch, error=RuntimeError("insufficient balance"))

    await evaluate_managed_mode()

    inserts = supabase.calls_for("signal_actions", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["action"] == "failed"
    assert inserts[0].values["initiated_by"] == "aria"
    assert "insufficient balance" in inserts[0].values["failure_reason"]


async def test_skips_execution_when_disabled_after_cycle_started(monkeypatch):
    # Simulates the TOCTOU race this re-check exists to close: the cycle's
    # top-level query already picked up this connection as enabled, but a
    # user (or the soft-disconnect path) flipped managed_mode_enabled to
    # False before _attempt_execution's own fresh check runs.
    supabase = _supabase_with(still_enabled=False)
    _patch_supabase(monkeypatch, supabase)
    calls = patch_bybit_client(monkeypatch)

    await evaluate_managed_mode()

    assert supabase.calls_for("signal_actions", "insert") == []
    # Never even reached order placement.
    assert not any(c[0] == "place_order" for c in calls)


async def test_still_executes_when_the_fresh_check_confirms_still_enabled(monkeypatch):
    supabase = _supabase_with(still_enabled=True)
    _patch_supabase(monkeypatch, supabase)
    patch_bybit_client(monkeypatch, order_id="order-fresh-check")

    await evaluate_managed_mode()

    inserts = supabase.calls_for("signal_actions", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["action"] == "executed"


async def test_skips_connection_when_balance_read_fails(monkeypatch):
    supabase = _supabase_with()
    _patch_supabase(monkeypatch, supabase)

    class _RaisingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def get_balance(self):
            raise RuntimeError("network error")

        async def aclose(self):
            pass

    monkeypatch.setattr(managed_mode, "BybitClient", _RaisingClient)

    await evaluate_managed_mode()

    assert supabase.calls_for("signal_actions", "insert") == []
    assert supabase.calls_for("broker_connections", "update") == []


async def test_converts_units_to_lots_for_metatrader(monkeypatch):
    monkeypatch.setattr(settings, "metaapi_token", "test-metaapi-token")
    supabase = _supabase_with(connections=[MT_CONNECTION])
    _patch_supabase(monkeypatch, supabase)
    calls = patch_metatrader_client(
        monkeypatch, balance=10000.0, order_id="mt-order-1", contract_sizes={"BTCUSDT": 100.0}
    )

    await evaluate_managed_mode()

    # units = (10000 * 1%) / 2000 = 0.05; lots = units / contract_size(100) = 0.0005
    place_order_call = next(c for c in calls if c[0] == "place_order")[1]
    assert place_order_call["volume"] == pytest.approx(0.0005)

    inserts = supabase.calls_for("signal_actions", "insert")
    assert inserts[0].values["executed_size"] == pytest.approx(0.0005)
