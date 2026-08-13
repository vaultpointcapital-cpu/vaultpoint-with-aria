from datetime import UTC, datetime, timedelta

import pytest

from app.scanner import service
from tests.conftest import FakeSupabase


def _raw_candle(offset_minutes: int, o: float, h: float, lo: float, c: float) -> dict:
    ts = (datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=offset_minutes)).isoformat()
    return {"time": ts, "open": o, "high": h, "low": lo, "close": c, "tickVolume": 10}


class _FakeMetaTraderClient:
    def __init__(self, candles: list[dict]):
        self._candles = candles
        self.closed = False
        self.requested = []

    async def get_candles(self, symbol, timeframe, limit=200):
        self.requested.append((symbol, timeframe, limit))
        return self._candles

    async def aclose(self):
        self.closed = True


# A liquidity-sweep sequence (same shape verified in test_scanner_rules.py)
# plus one extra still-forming candle at the end that scan_setups() must
# drop before handing candles to the rules engine.
_SWEEP_CANDLES = [
    _raw_candle(0, 100, 102, 99, 101),
    _raw_candle(1, 101, 103, 98, 100),
    _raw_candle(2, 100, 101, 90, 95),
    _raw_candle(3, 95, 100, 94, 98),
    _raw_candle(4, 98, 102, 96, 100),
    _raw_candle(5, 100, 101, 85, 97),  # the closed candle that should trigger a detection
    _raw_candle(6, 97, 98, 96, 97.5),  # still-forming candle — must be dropped, not scanned
]


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(service, "get_service_client", lambda: fake)
    return fake


async def test_scan_setups_upserts_a_candidate_from_a_known_pattern(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("watchlist_symbols", "*")] = [
        {"symbol": "XAUUSD", "broker": "metatrader", "timeframe": "M5", "enabled": True}
    ]
    fake_client = _FakeMetaTraderClient(_SWEEP_CANDLES)
    monkeypatch.setattr(service, "_get_market_data_client", lambda supabase: _async_return(fake_client))

    await service.scan_setups()

    upserts = fake_supabase.calls_for("candidate_setups", "upsert")
    assert len(upserts) == 1
    rows = upserts[0].rows
    assert len(rows) == 1
    assert rows[0]["structure_type"] == "liquidity_sweep"
    assert rows[0]["symbol"] == "XAUUSD"
    assert rows[0]["timeframe"] == "M5"
    # The still-forming candle (offset 6) must never be the one that
    # triggered the detection — the sweep candle is offset 5.
    assert rows[0]["candle_timestamp"] == (datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=5)).isoformat()
    assert upserts[0].on_conflict == "symbol,timeframe,structure_type,candle_timestamp"
    assert upserts[0].ignore_duplicates is True
    assert fake_client.closed is True


async def test_scan_setups_skips_when_watchlist_is_empty(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("watchlist_symbols", "*")] = []
    called = False

    def _should_not_be_called(supabase):
        nonlocal called
        called = True
        return _async_return(_FakeMetaTraderClient([]))

    monkeypatch.setattr(service, "_get_market_data_client", _should_not_be_called)

    await service.scan_setups()

    assert called is False
    assert fake_supabase.calls_for("candidate_setups", "upsert") == []


async def test_scan_setups_skips_symbol_with_unsupported_timeframe(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("watchlist_symbols", "*")] = [
        {"symbol": "XAUUSD", "broker": "metatrader", "timeframe": "M30", "enabled": True}
    ]
    fake_client = _FakeMetaTraderClient(_SWEEP_CANDLES)
    monkeypatch.setattr(service, "_get_market_data_client", lambda supabase: _async_return(fake_client))

    await service.scan_setups()

    assert fake_client.requested == []
    assert fake_supabase.calls_for("candidate_setups", "upsert") == []


async def test_scan_setups_skips_cycle_with_no_healthy_metatrader_connection(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("watchlist_symbols", "*")] = [
        {"symbol": "XAUUSD", "broker": "metatrader", "timeframe": "M5", "enabled": True}
    ]
    monkeypatch.setattr(service, "_get_market_data_client", lambda supabase: _async_return(None))

    await service.scan_setups()

    assert fake_supabase.calls_for("candidate_setups", "upsert") == []


async def _async_return(value):
    return value
