"""Aria Pantheon — shared "live REAL net worth" computation, used by
Argus's portfolio drawdown check (argus.py) and Hermes's cool-down gate
(hermes.py). Mirrors alert_engine.py's single-currency guard and
financial.py's calculate_net_worth — duplicated rather than imported
(alert_engine's version is a private, module-internal helper, not a
shared export) but centralized once here for Pantheon's own two callers
rather than tripled across argus.py/hermes.py individually.
"""

import asyncio
from decimal import Decimal

from ..financial import calculate_net_worth


async def get_current_real_net_worth(supabase, user_id: str) -> float | None:
    """None if there's no data, or if positions/manual assets span more
    than one currency (see alert_engine._single_currency's identical
    guard) — mixing currencies here would silently produce a WRONG sum,
    not throw, so this returns "no data" rather than compute one."""
    positions_result = await asyncio.to_thread(
        lambda: supabase.table("positions").select("*").eq("user_id", user_id).eq("reality", "real").execute()
    )
    manual_result = await asyncio.to_thread(
        lambda: supabase.table("manual_assets").select("value, currency").eq("user_id", user_id).execute()
    )
    positions = positions_result.data
    manual_assets = manual_result.data

    currencies = {p.get("currency", "USD") for p in positions} | {
        a.get("currency", "USD") for a in manual_assets
    }
    if len(currencies) > 1:
        return None

    d_positions = [
        {
            **p,
            "size": Decimal(str(p["size"])),
            "entry_price": Decimal(str(p["entry_price"])),
            "mark_price": Decimal(str(p["mark_price"])) if p.get("mark_price") is not None else None,
        }
        for p in positions
    ]
    d_manual = [{**a, "value": Decimal(str(a["value"]))} for a in manual_assets]
    return float(calculate_net_worth(d_positions, d_manual))
