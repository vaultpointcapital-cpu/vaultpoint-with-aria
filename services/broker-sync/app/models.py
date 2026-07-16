from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel

PositionSide = Literal["long", "short", "buy", "sell"]


class BrokerType(str, Enum):
    """Mirrors broker_connections.broker's check constraint in
    supabase/migrations/20260617000000_initial_schema.sql exactly — that
    migration is the source of truth. Add a member here the same day the
    constraint gains one; nothing else in this service should hardcode a
    broker string, so a typo'd or stale broker name fails at import
    (AttributeError on a missing enum member) instead of silently never
    matching anything at runtime.
    """

    BYBIT = "bybit"
    BINANCE = "binance"
    KUCOIN = "kucoin"
    METATRADER = "metatrader"


class Position(BaseModel):
    """Broker-agnostic normalized position. Every BrokerClient.get_positions()
    implementation returns a list of these regardless of the raw shape the
    underlying broker API uses — this is the only shape the rest of the
    service (caching, Supabase upsert) ever deals with."""

    symbol: str
    side: PositionSide
    size: float
    entry_price: float
    mark_price: Optional[float] = None
    leverage: float = 1
    unrealized_pnl: Optional[float] = None
    unrealized_pnl_pct: Optional[float] = None
    margin_used: Optional[float] = None
    broker_source: BrokerType
