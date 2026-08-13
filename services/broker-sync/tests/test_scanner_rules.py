"""Hand-built synthetic candle sequences — each test constructs a candle
array that deterministically contains (or deliberately omits) exactly one
known SMC structure, so these assert the detector fires on the intended
candle and not on noise. No mocking needed; app/scanner/rules.py is pure."""

from datetime import UTC, datetime, timedelta

from app.scanner import rules

_BASE = datetime(2026, 1, 1, tzinfo=UTC)


def _c(offset_minutes: int, o: float, h: float, lo: float, c: float, v: float = 100.0) -> rules.Candle:
    return {
        "timestamp": _BASE + timedelta(minutes=offset_minutes),
        "open": o,
        "high": h,
        "low": lo,
        "close": c,
        "volume": v,
    }


class TestLiquiditySweep:
    def test_bullish_sweep_of_swing_low_fires_long(self):
        candles = [
            _c(0, 100, 102, 99, 101),
            _c(1, 101, 103, 98, 100),
            _c(2, 100, 101, 90, 95),  # confirmed swing low (l=90)
            _c(3, 95, 100, 94, 98),
            _c(4, 98, 102, 96, 100),
            _c(5, 100, 101, 85, 97),  # sweeps below 90, closes back above it
        ]

        detections = rules.detect_liquidity_sweep(candles)

        assert len(detections) == 1
        d = detections[0]
        assert d["structure_type"] == "liquidity_sweep"
        assert d["direction"] == "long"
        assert d["candle_timestamp"] == candles[-1]["timestamp"]
        assert d["stop_loss"] < 85  # below the sweep low, not at it
        assert d["take_profit"] > d["entry_zone_high"]

    def test_no_sweep_on_a_candle_that_stays_inside_range(self):
        candles = [
            _c(0, 100, 102, 99, 101),
            _c(1, 101, 103, 98, 100),
            _c(2, 100, 101, 90, 95),
            _c(3, 95, 100, 94, 98),
            _c(4, 98, 102, 96, 100),
            _c(5, 100, 101, 96, 99),  # never goes below the swing low at all
        ]

        assert rules.detect_liquidity_sweep(candles) == []

    def test_too_few_candles_returns_empty(self):
        assert rules.detect_liquidity_sweep([_c(0, 1, 2, 0.5, 1.5)]) == []


class TestBosChoch:
    # Highs/lows use widely separated extremes (80/90 vs. a flat 50
    # baseline) so pivot detection is unambiguous — every "buffer" candle
    # shares the exact same high (50) or low (40) as its neighbors, which
    # fails the strict-inequality pivot check by design, isolating exactly
    # the four intended swing points at indices 2, 5, 8, 11.
    _BUFFER_H, _BUFFER_L = 50, 40

    def _buffer(self, i: int) -> rules.Candle:
        return _c(i, 45, self._BUFFER_H, self._BUFFER_L, 45)

    def _uptrend_history(self) -> list[rules.Candle]:
        candles = [self._buffer(i) for i in range(14)]
        candles[2] = _c(2, 45, 50, 20, 45)  # swing low 1
        candles[5] = _c(5, 45, 80, 40, 45)  # swing high 1
        candles[8] = _c(8, 45, 50, 25, 45)  # swing low 2 — higher than low 1
        candles[11] = _c(11, 45, 90, 40, 45)  # swing high 2 — higher than high 1
        return candles

    def _downtrend_history(self) -> list[rules.Candle]:
        candles = [self._buffer(i) for i in range(14)]
        candles[2] = _c(2, 45, 50, 25, 45)  # swing low 1
        candles[5] = _c(5, 45, 90, 40, 45)  # swing high 1
        candles[8] = _c(8, 45, 50, 20, 45)  # swing low 2 — lower than low 1
        candles[11] = _c(11, 45, 80, 40, 45)  # swing high 2 — lower than high 1
        return candles

    def test_break_above_swing_high_in_uptrend_is_bos(self):
        history = self._uptrend_history()
        last = _c(14, 90, 105, 88, 100)  # closes above swing high 2 (90)
        candles = [*history, last]

        detections = rules.detect_bos_choch(candles)

        assert len(detections) == 1
        d = detections[0]
        assert d["structure_type"] == "bos"
        assert d["direction"] == "long"
        assert d["candle_timestamp"] == last["timestamp"]

    def test_break_above_swing_high_in_downtrend_is_choch(self):
        history = self._downtrend_history()
        last = _c(14, 80, 105, 78, 100)  # closes above swing high 2 (80)
        candles = [*history, last]

        detections = rules.detect_bos_choch(candles)

        assert len(detections) == 1
        d = detections[0]
        assert d["structure_type"] == "choch"
        assert d["direction"] == "long"

    def test_no_break_no_detection(self):
        history = self._uptrend_history()
        last = _c(14, 45, 60, 44, 50)  # stays well inside range
        candles = [*history, last]

        assert rules.detect_bos_choch(candles) == []


class TestOrderBlockRetest:
    def test_bullish_order_block_retest_fires_long(self):
        candles = [
            _c(0, 100, 101, 99, 101),
            _c(1, 101, 102, 100, 102),
            _c(2, 102, 103, 101, 103),
            _c(3, 103, 104, 102, 104),
            _c(4, 104, 105, 103, 105),
            _c(5, 101, 104, 99, 100),  # order block: down candle, wide wick [99,104]
            _c(6, 100, 122, 99, 120),  # impulse: strong up move
            _c(7, 120, 123, 119, 121),
            _c(8, 121, 124, 120, 122),
            _c(9, 122, 125, 121, 123),
            _c(10, 123, 126, 122, 124),
            _c(11, 124, 127, 123, 125),
            _c(12, 110, 112, 100, 108),  # retest: dips back into [99, 104]
        ]

        detections = rules.detect_order_block_retest(candles)

        assert len(detections) == 1
        d = detections[0]
        assert d["structure_type"] == "order_block_retest"
        assert d["direction"] == "long"
        assert d["entry_zone_low"] == 99
        assert d["entry_zone_high"] == 104
        assert d["stop_loss"] < 99

    def test_no_retest_yet_no_detection(self):
        candles = [
            _c(0, 100, 101, 99, 101),
            _c(1, 101, 102, 100, 102),
            _c(2, 102, 103, 101, 103),
            _c(3, 103, 104, 102, 104),
            _c(4, 104, 105, 103, 105),
            _c(5, 101, 104, 99, 100),
            _c(6, 100, 122, 99, 120),
            _c(7, 120, 123, 119, 121),
            _c(8, 121, 124, 120, 122),
            _c(9, 122, 125, 121, 123),
            _c(10, 123, 126, 122, 124),
            _c(11, 124, 127, 123, 125),
            _c(12, 126, 129, 125, 128),  # keeps trending up, never returns to the zone
        ]

        assert rules.detect_order_block_retest(candles) == []


class TestFvgFill:
    def test_bullish_fvg_fill_fires_long(self):
        candles = [
            _c(0, 45, 50, 45, 48),  # c0: high = 50
            _c(1, 60, 90, 60, 85),  # displacement candle in between
            _c(2, 70, 75, 70, 72),  # c2: low = 70 -> gap [50, 70]
            _c(3, 60, 65, 55, 60),  # fills back into the gap
        ]

        detections = rules.detect_fvg_fill(candles)

        assert len(detections) == 1
        d = detections[0]
        assert d["structure_type"] == "fvg_fill"
        assert d["direction"] == "long"
        assert d["entry_zone_low"] == 50
        assert d["entry_zone_high"] == 70

    def test_unfilled_gap_no_detection(self):
        candles = [
            _c(0, 45, 50, 45, 48),
            _c(1, 60, 90, 60, 85),
            _c(2, 70, 75, 70, 72),
            _c(3, 80, 85, 78, 82),  # stays above the gap entirely
        ]

        assert rules.detect_fvg_fill(candles) == []


class TestDetectAll:
    def test_aggregates_across_detectors_without_crashing(self):
        candles = [
            _c(0, 100, 102, 99, 101),
            _c(1, 101, 103, 98, 100),
            _c(2, 100, 101, 90, 95),
            _c(3, 95, 100, 94, 98),
            _c(4, 98, 102, 96, 100),
            _c(5, 100, 101, 85, 97),
        ]

        detections = rules.detect_all(candles)

        assert isinstance(detections, list)
        assert any(d["structure_type"] == "liquidity_sweep" for d in detections)
