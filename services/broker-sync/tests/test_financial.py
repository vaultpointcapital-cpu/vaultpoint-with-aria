"""Mirrors the cases in src/__tests__/financial.test.ts for the functions
this service ported — same inputs, same expected outputs, in both
languages. Money & Currency Layer: every amount here is decimal.Decimal,
constructed via Decimal(str(x)) — never Decimal(x) directly on a float,
which just encodes the float's own imprecision exactly."""

from decimal import Decimal

from app.financial import (
    calculate_margin_utilization,
    calculate_net_worth,
    calculate_position_pnl,
    calculate_position_pnl_pct,
    calculate_position_value,
    calculate_total_pnl,
)


def D(x: str) -> Decimal:
    return Decimal(x)


def test_profitable_long():
    assert calculate_position_pnl("long", D("1"), D("100"), D("110")) == D("10")


def test_losing_long():
    assert calculate_position_pnl("long", D("1"), D("100"), D("90")) == D("-10")


def test_profitable_short():
    assert calculate_position_pnl("short", D("1"), D("100"), D("90")) == D("10")


def test_losing_short():
    assert calculate_position_pnl("short", D("1"), D("100"), D("110")) == D("-10")


def test_scales_with_size():
    pnl = calculate_position_pnl("long", D("0.42"), D("67000"), D("68000"))
    assert pnl == D("420.00")


def test_pnl_pct_zero_entry_value():
    assert calculate_position_pnl_pct("long", D("0"), D("0"), D("110")) == 0


def test_pnl_pct_normal_case():
    pct = calculate_position_pnl_pct("long", D("1"), D("100"), D("110"))
    assert round(pct, 2) == 10.0


def test_position_value_uses_mark_price_when_present():
    assert calculate_position_value(D("110"), D("100"), D("2")) == D("220")


def test_position_value_falls_back_to_entry_price():
    assert calculate_position_value(None, D("100"), D("2")) == D("200")


def test_ten_thousand_additions_no_drift():
    """The Money & Currency Layer's core failure mode (D1): JS/float
    accumulates error across many small additions. Decimal must not."""
    total = Decimal(0)
    for _ in range(10_000):
        total += Decimal("0.00000001")
    assert total == Decimal("0.0001")


def test_calculate_total_pnl_skips_unsynced_positions():
    positions = [
        {"side": "long", "size": D("1"), "entry_price": D("100"), "mark_price": D("110")},
        {"side": "long", "size": D("1"), "entry_price": D("100"), "mark_price": None},
    ]
    assert calculate_total_pnl(positions) == D("10")


def test_calculate_net_worth_sums_positions_and_manual_assets():
    positions = [{"size": D("1"), "mark_price": D("1000"), "entry_price": D("900")}]
    manual_assets = [{"value": D("5000")}]
    assert calculate_net_worth(positions, manual_assets) == D("6000")


def test_calculate_net_worth_empty_is_zero():
    assert calculate_net_worth([], []) == D("0")


def test_margin_utilization_zero_equity():
    assert calculate_margin_utilization(D("100"), D("0")) == 0.0


def test_margin_utilization_clamped_at_100():
    assert calculate_margin_utilization(D("150"), D("100")) == 100.0
