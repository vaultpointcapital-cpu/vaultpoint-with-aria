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


def calculate_total_pnl(positions: list[dict]) -> float:
    """Port of src/lib/utils/financial.ts's calculateTotalPnl. Positions
    with no mark_price yet (just opened, not synced) are skipped, same
    as the TS version."""
    total = 0.0
    for p in positions:
        if p.get("mark_price") is None:
            continue
        total += calculate_position_pnl(p["side"], p["size"], p["entry_price"], p["mark_price"])
    return total


def calculate_net_worth(positions: list[dict], manual_assets: list[dict]) -> float:
    """Port of src/lib/utils/financial.ts's calculateNetWorth."""
    positions_value = sum(
        calculate_position_value(p.get("mark_price"), p["entry_price"], p["size"]) for p in positions
    )
    manual_value = sum(a["value"] for a in manual_assets)
    return positions_value + manual_value


def calculate_margin_utilization(margin_used: float, total_equity: float) -> float:
    """Port of src/lib/utils/financial.ts's calculateMarginUtilization.
    total_equity is net worth, not just position value — same
    "margin used against everything you own" meaning as the TS version."""
    if total_equity <= 0:
        return 0.0
    return min(100.0, (margin_used / total_equity) * 100)


def calculate_portfolio_pnl_pct(positions: list[dict]) -> float:
    """Portfolio-wide analog of calculate_position_pnl_pct — no direct TS
    equivalent exists yet (financial.ts only has the per-position
    version), so this follows the same shape: total unrealized P&L over
    total entry value, aggregated instead of per-position."""
    total_entry_value = sum(p["entry_price"] * p["size"] for p in positions)
    if total_entry_value == 0:
        return 0.0
    return (calculate_total_pnl(positions) / total_entry_value) * 100
