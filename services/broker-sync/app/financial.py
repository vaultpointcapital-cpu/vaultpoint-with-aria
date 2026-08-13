"""Direct port of src/lib/utils/financial.ts's per-position formulas.

That file's own docstring says these are "safe to call from both the
Next.js API routes and (translated) the FastAPI service without drift" —
this module is that translation. Keep it byte-for-byte equivalent to the
TS version; if one changes, the other must change with it.

Money & Currency Layer: every amount is Decimal (stdlib — Python already
has exact decimal arithmetic, no third-party dependency needed the way
TypeScript needed decimal.js), never float. Unlike the TS side's Money
class, there's no currency-safety wrapper here (no bespoke Money class,
per the Money & Currency Layer plan's explicit scope decision) — callers
are responsible for passing already-same-currency Decimals into the
aggregation functions, same "caller normalizes first" rule as the TS
side, just without a runtime currency-mismatch assertion. Construct every
Decimal via Decimal(str(x)) at the boundary — never Decimal(x) directly
on a float, which just encodes the float's own imprecision exactly.
"""

from decimal import Decimal

PositionSide = str  # 'long' | 'short' | 'buy' | 'sell'


def calculate_position_pnl(side: PositionSide, size: Decimal, entry_price: Decimal, mark_price: Decimal) -> Decimal:
    is_long = side in ("long", "buy")
    price_diff = mark_price - entry_price
    return price_diff * size if is_long else -price_diff * size


def calculate_position_pnl_pct(side: PositionSide, size: Decimal, entry_price: Decimal, mark_price: Decimal) -> float:
    entry_value = entry_price * size
    if entry_value == 0:
        return 0.0
    pnl = calculate_position_pnl(side, size, entry_price, mark_price)
    return float((pnl / entry_value) * 100)


def calculate_position_value(mark_price: Decimal | None, entry_price: Decimal, size: Decimal) -> Decimal:
    price = mark_price if mark_price is not None else entry_price
    return abs(size) * price


def calculate_total_pnl(positions: list[dict]) -> Decimal:
    """Port of src/lib/utils/financial.ts's calculateTotalPnl. Positions
    with no mark_price yet (just opened, not synced) are skipped, same
    as the TS version. Every position must already carry same-currency
    Decimal values — the caller's responsibility, same as the TS side."""
    total = Decimal(0)
    for p in positions:
        if p.get("mark_price") is None:
            continue
        total += calculate_position_pnl(p["side"], p["size"], p["entry_price"], p["mark_price"])
    return total


def calculate_net_worth(positions: list[dict], manual_assets: list[dict]) -> Decimal:
    """Port of src/lib/utils/financial.ts's calculateNetWorth. Every
    position/asset must already be Decimal-valued and in the same
    currency (converted via fx_service.py's rates before calling this) —
    this function has no I/O and cannot convert for itself."""
    positions_value = sum(
        (calculate_position_value(p.get("mark_price"), p["entry_price"], p["size"]) for p in positions),
        Decimal(0),
    )
    manual_value = sum((a["value"] for a in manual_assets), Decimal(0))
    return positions_value + manual_value


def calculate_margin_utilization(margin_used: Decimal, total_equity: Decimal) -> float:
    """Port of src/lib/utils/financial.ts's calculateMarginUtilization.
    total_equity is net worth, not just position value — same
    "margin used against everything you own" meaning as the TS version."""
    if total_equity <= 0:
        return 0.0
    return min(100.0, float((margin_used / total_equity) * 100))


def calculate_portfolio_pnl_pct(positions: list[dict]) -> float:
    """Portfolio-wide analog of calculate_position_pnl_pct — no direct TS
    equivalent exists yet (financial.ts only has the per-position
    version), so this follows the same shape: total unrealized P&L over
    total entry value, aggregated instead of per-position."""
    total_entry_value = sum((p["entry_price"] * p["size"] for p in positions), Decimal(0))
    if total_entry_value == 0:
        return 0.0
    return float((calculate_total_pnl(positions) / total_entry_value) * 100)
