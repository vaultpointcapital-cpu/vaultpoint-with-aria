from app.portfolio_risk.exposure import (
    CryptoAsset,
    FxPair,
    aggregate_book_exposure,
    classify_symbol,
    compute_drawdown_pct,
    leg_notionals_usd,
)

FX_RATES = {"EUR": 1.08, "JPY": 0.0067, "GBP": 1.27, "XAU": 2400.0}


class TestClassifySymbol:
    def test_fx_pair(self):
        assert classify_symbol("EURJPY") == FxPair(base="EUR", quote="JPY")

    def test_metal_pair(self):
        assert classify_symbol("XAUUSD") == FxPair(base="XAU", quote="USD")

    def test_crypto_usdt(self):
        assert classify_symbol("BTCUSDT") == CryptoAsset(base="BTC")

    def test_crypto_usd(self):
        assert classify_symbol("BTCUSD") == CryptoAsset(base="BTC")

    def test_unclassified_symbol(self):
        assert classify_symbol("NOTASYMBOL") is None

    def test_unclassified_short_garbage(self):
        assert classify_symbol("XYZ") is None


class TestLegNotionalsUsd:
    def test_long_fx_pair_nets_positive_base_negative_quote(self):
        position = {"symbol": "EURJPY", "side": "long", "size": 1000, "entry_price": 160.0, "mark_price": 160.0}
        legs = leg_notionals_usd(position, FX_RATES)

        assert legs["EUR"] == 1000 * 1.08
        assert legs["JPY"] == -1000 * 160.0 * 0.0067

    def test_short_fx_pair_flips_both_signs(self):
        position = {"symbol": "EURJPY", "side": "short", "size": 1000, "entry_price": 160.0, "mark_price": 160.0}
        legs = leg_notionals_usd(position, FX_RATES)

        assert legs["EUR"] == -1000 * 1.08
        assert legs["JPY"] == 1000 * 160.0 * 0.0067

    def test_crypto_position_is_a_single_usd_denominated_leg(self):
        position = {"symbol": "BTCUSDT", "side": "long", "size": 0.5, "entry_price": 60000, "mark_price": 61000}
        legs = leg_notionals_usd(position, FX_RATES)

        assert legs == {"BTC": 0.5 * 61000}

    def test_missing_fx_rate_is_skipped_not_defaulted(self):
        position = {"symbol": "GBPCHF", "side": "long", "size": 1000, "entry_price": 1.15, "mark_price": 1.15}
        legs = leg_notionals_usd(position, FX_RATES)  # CHF has no rate in FX_RATES

        assert "GBP" in legs
        assert "CHF" not in legs

    def test_usd_leg_never_looked_up(self):
        position = {"symbol": "XAUUSD", "side": "long", "size": 10, "entry_price": 2400.0, "mark_price": 2400.0}
        legs = leg_notionals_usd(position, {"XAU": 2400.0})  # no "USD" key at all

        assert "USD" in legs  # implicitly rate 1.0, never a missing-rate skip

    def test_unclassified_symbol_returns_no_legs(self):
        position = {"symbol": "NOTASYMBOL", "side": "long", "size": 1, "entry_price": 1, "mark_price": 1}
        assert leg_notionals_usd(position, FX_RATES) == {}

    def test_missing_size_returns_no_legs(self):
        position = {"symbol": "EURJPY", "side": "long", "size": None, "entry_price": 160.0, "mark_price": 160.0}
        assert leg_notionals_usd(position, FX_RATES) == {}


class TestAggregateBookExposure:
    def test_five_jpy_cross_trades_net_into_one_concentrated_jpy_figure(self):
        # The PRD's own example: five uncorrelated-looking JPY-cross
        # trades should sum to one large net JPY exposure figure — this
        # is the test that directly proves the concentration mechanism
        # catches it.
        positions = [
            {"symbol": "EURJPY", "side": "long", "size": 1000, "entry_price": 160.0, "mark_price": 160.0},
            {"symbol": "GBPJPY", "side": "long", "size": 1000, "entry_price": 190.0, "mark_price": 190.0},
            {"symbol": "AUDJPY", "side": "long", "size": 1000, "entry_price": 95.0, "mark_price": 95.0},
            {"symbol": "CADJPY", "side": "long", "size": 1000, "entry_price": 108.0, "mark_price": 108.0},
            {"symbol": "NZDJPY", "side": "long", "size": 1000, "entry_price": 88.0, "mark_price": 88.0},
        ]
        rates = {"EUR": 1.08, "GBP": 1.27, "AUD": 0.65, "CAD": 0.73, "NZD": 0.60, "JPY": 0.0067}

        exposure = aggregate_book_exposure(positions, rates)

        expected_jpy = -sum(
            1000 * price * rates["JPY"] for price in (160.0, 190.0, 95.0, 108.0, 88.0)
        )
        assert exposure["JPY"] == expected_jpy
        assert exposure["JPY"] < 0  # five long-JPY-cross trades = short JPY, a real concentrated bet

    def test_empty_book_has_no_exposure(self):
        assert aggregate_book_exposure([], FX_RATES) == {}


class TestComputeDrawdownPct:
    def test_exactly_at_threshold(self):
        assert compute_drawdown_pct(-800, 10000) == -8.0

    def test_just_above_threshold_is_a_smaller_loss(self):
        assert compute_drawdown_pct(-799, 10000) > -8.0

    def test_just_below_threshold_is_a_larger_loss(self):
        assert compute_drawdown_pct(-801, 10000) < -8.0

    def test_zero_baseline_returns_none_not_a_division_error(self):
        assert compute_drawdown_pct(-100, 0) is None

    def test_negative_baseline_returns_none(self):
        assert compute_drawdown_pct(-100, -5000) is None

    def test_none_baseline_returns_none(self):
        assert compute_drawdown_pct(-100, None) is None

    def test_positive_pnl_is_a_positive_percentage(self):
        assert compute_drawdown_pct(500, 10000) == 5.0
