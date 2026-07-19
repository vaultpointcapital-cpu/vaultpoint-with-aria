import pytest

from app.signal_outcomes import detect_and_record_outcomes
from tests.conftest import FakeSupabase

CONNECTION = {"id": "conn-1", "broker": "bybit"}

STALE_BTC_LONG = {
    "id": "pos-1",
    "symbol": "BTCUSDT",
    "side": "long",
    "synced_at": "2026-07-19T00:00:00+00:00",
}

SIGNAL = {"id": "signal-1", "pair": "BTCUSDT", "direction": "long", "entry_price": 65000, "stop_loss": 63000}

ACTION = {"id": "action-1", "signal_id": "signal-1", "executed_size": 0.01}


def _supabase_with(actions=None, signals=None, outcomes=None) -> FakeSupabase:
    supabase = FakeSupabase()
    supabase.select_responses[("signal_actions", "id, signal_id, executed_size")] = actions or []
    supabase.select_responses[("signals", "id, pair, direction, entry_price, stop_loss")] = signals or []
    supabase.select_responses[("signal_outcomes", "signal_action_id")] = outcomes or []
    return supabase


class _FakeBybitClient:
    def __init__(self, entries=None, error: Exception | None = None):
        self.entries = entries or []
        self.error = error
        self.calls = []

    async def get_closed_pnl(self, *, symbol, start_time_ms, end_time_ms):
        self.calls.append((symbol, start_time_ms, end_time_ms))
        if self.error:
            raise self.error
        return self.entries


async def test_records_a_win_for_the_single_unambiguous_candidate():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    inserts = supabase.calls_for("signal_outcomes", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["signal_action_id"] == "action-1"
    assert inserts[0].values["result"] == "win"
    assert inserts[0].values["realized_pnl"] == 200.0
    # risk_amount = 0.01 * (65000 - 63000) = 20; r_multiple = 200 / 20 = 10
    assert inserts[0].values["realized_r_multiple"] == 10.0


async def test_records_a_loss():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(entries=[{"closedPnl": "-50.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    inserts = supabase.calls_for("signal_outcomes", "insert")
    assert inserts[0].values["result"] == "loss"
    assert inserts[0].values["realized_pnl"] == -50.0


async def test_records_a_breakeven_for_a_near_zero_pnl():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(entries=[{"closedPnl": "0.001", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    inserts = supabase.calls_for("signal_outcomes", "insert")
    assert inserts[0].values["result"] == "breakeven"


async def test_no_op_when_no_signal_actions_exist_for_this_symbol_side():
    supabase = _supabase_with(actions=[], signals=[])
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []
    # Never even calls the broker if there's no candidate to attribute to.
    assert client.calls == []


async def test_no_op_when_the_candidate_already_has_an_outcome():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL], outcomes=[{"signal_action_id": "action-1"}])
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []


async def test_skips_attribution_when_multiple_unmatched_candidates_are_ambiguous():
    second_action = {"id": "action-2", "signal_id": "signal-2", "executed_size": 0.02}
    second_signal = {"id": "signal-2", "pair": "BTCUSDT", "direction": "long", "entry_price": 64000, "stop_loss": 62000}
    supabase = _supabase_with(actions=[ACTION, second_action], signals=[SIGNAL, second_signal])
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []
    # Ambiguous — must never guess which candidate the PnL belongs to.
    assert client.calls == []


async def test_skips_attribution_when_closed_size_is_far_from_executed_size():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    # executed_size was 0.01; broker reports a close of 1.0 — wildly
    # different, e.g. a manual add to the same merged Bybit position.
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "1.0"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []


async def test_tolerates_a_small_size_difference_within_tolerance():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    # 0.0102 vs executed_size 0.01 is a 2% difference — within the 5% tolerance.
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.0102"}])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert len(supabase.calls_for("signal_outcomes", "insert")) == 1


async def test_no_op_when_broker_call_fails():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(error=RuntimeError("Bybit API rate limit exceeded after retries."))

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []


async def test_no_op_when_broker_returns_no_closed_pnl_entries():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(entries=[])

    await detect_and_record_outcomes(supabase, client, CONNECTION, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []


async def test_a_failure_on_one_stale_position_does_not_block_another():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    broken_stale = {"id": "pos-2", "symbol": None, "side": None, "synced_at": None}

    await detect_and_record_outcomes(supabase, client, CONNECTION, [broken_stale, STALE_BTC_LONG])

    # broken_stale no-ops silently (missing symbol/side/since); the real
    # one still gets recorded.
    assert len(supabase.calls_for("signal_outcomes", "insert")) == 1


class _FakeMetaTraderClient:
    def __init__(self, deals=None, error: Exception | None = None):
        self.deals = deals or []
        self.error = error
        self.calls = []

    async def get_history_deals(self, *, start_time, end_time):
        self.calls.append((start_time, end_time))
        if self.error:
            raise self.error
        return self.deals


async def test_records_an_outcome_for_metatrader_using_history_deals():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    connection = {"id": "conn-mt-1", "broker": "metatrader"}
    client = _FakeMetaTraderClient(
        deals=[
            {
                "symbol": "BTCUSDT",
                "entryType": "DEAL_ENTRY_OUT",
                "volume": 0.01,
                "profit": 210.0,
                "commission": -1.0,
                "swap": -0.5,
            }
        ]
    )

    await detect_and_record_outcomes(supabase, client, connection, [STALE_BTC_LONG])

    inserts = supabase.calls_for("signal_outcomes", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["realized_pnl"] == pytest.approx(208.5)
    assert inserts[0].values["result"] == "win"


async def test_metatrader_ignores_deals_for_other_symbols_and_entry_deals():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    connection = {"id": "conn-mt-1", "broker": "metatrader"}
    client = _FakeMetaTraderClient(
        deals=[
            {"symbol": "ETHUSDT", "entryType": "DEAL_ENTRY_OUT", "volume": 1, "profit": 999},
            {"symbol": "BTCUSDT", "entryType": "DEAL_ENTRY_IN", "volume": 0.01, "profit": 0},
        ]
    )

    await detect_and_record_outcomes(supabase, client, connection, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []


async def test_unsupported_broker_is_a_no_op():
    supabase = _supabase_with(actions=[ACTION], signals=[SIGNAL])
    connection = {"id": "conn-1", "broker": "binance"}
    client = _FakeBybitClient(entries=[{"closedPnl": "200.0", "closedSize": "0.01"}])

    await detect_and_record_outcomes(supabase, client, connection, [STALE_BTC_LONG])

    assert supabase.calls_for("signal_outcomes", "insert") == []
