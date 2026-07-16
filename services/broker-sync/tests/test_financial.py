"""Mirrors the cases in src/__tests__/financial.test.ts for the functions
this service ported — same inputs, same expected outputs, in both
languages."""

from app.financial import (
    calculate_position_pnl,
    calculate_position_pnl_pct,
    calculate_position_value,
)


def test_profitable_long():
    assert calculate_position_pnl("long", 1, 100, 110) == 10


def test_losing_long():
    assert calculate_position_pnl("long", 1, 100, 90) == -10


def test_profitable_short():
    assert calculate_position_pnl("short", 1, 100, 90) == 10


def test_losing_short():
    assert calculate_position_pnl("short", 1, 100, 110) == -10


def test_scales_with_size():
    pnl = calculate_position_pnl("long", 0.42, 67000, 68000)
    assert round(pnl, 2) == 420.0


def test_pnl_pct_zero_entry_value():
    assert calculate_position_pnl_pct("long", 0, 0, 110) == 0


def test_pnl_pct_normal_case():
    pct = calculate_position_pnl_pct("long", 1, 100, 110)
    assert round(pct, 2) == 10.0


def test_position_value_uses_mark_price_when_present():
    assert calculate_position_value(110, 100, 2) == 220


def test_position_value_falls_back_to_entry_price():
    assert calculate_position_value(None, 100, 2) == 200
