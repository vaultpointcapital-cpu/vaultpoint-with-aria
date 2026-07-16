"""Direct port of src/lib/utils/financial.ts's per-position formulas.

That file's own docstring says these are "safe to call from both the
Next.js API routes and (translated) the FastAPI service without drift" —
this module is that translation. Keep it byte-for-byte equivalent to the
TS version; if one changes, the other must change with it.
"""


PositionSide = str  # 'long' | 'short' | 'buy' | 'sell'


def calculate_position_pnl(
    side: PositionSide, size: float, entry_price: float, mark_price: float
) -> float:
    is_long = side in ("long", "buy")
    price_diff = mark_price - entry_price
    return price_diff * size if is_long else -price_diff * size


def calculate_position_pnl_pct(
    side: PositionSide, size: float, entry_price: float, mark_price: float
) -> float:
    entry_value = entry_price * size
    if entry_value == 0:
        return 0.0
    pnl = calculate_position_pnl(side, size, entry_price, mark_price)
    return (pnl / entry_value) * 100


def calculate_position_value(
    mark_price: float | None, entry_price: float, size: float
) -> float:
    price = mark_price if mark_price is not None else entry_price
    return abs(size) * price
