"""Scanner Service orchestrator (PRD Sprint 1, component 4A) — the
scheduled job's actual work, wrapped by scheduler.py's scan_setups() for
the lock/heartbeat shape every other job in this service uses.

MetaApi's historical-market-data endpoint is scoped to a specific
provisioned account (/users/current/accounts/{id}/historical-market-data/
...), not a broker-wide "give me candles for any symbol" call — there is
no account-independent market-data API. This module therefore borrows
whichever healthy MetaTrader broker_connection happens to exist as its
market-data source client. Candle data for a given symbol/server is the
same regardless of which connected account fetches it, so this is safe
for a single-broker/server deployment, but is a real simplification: a
user on a different MT5 server with different symbol suffixes (e.g.
XAUUSD vs XAUUSDm) would see scans miss or misfire for their variant.
Flagged, not silently assumed away — a dedicated market-data-only MetaApi
account (decoupled from any single user's connection) is the correct fix
once the watchlist needs to span multiple brokers/servers, not attempted
in this phase.
"""

import asyncio
import logging
from datetime import UTC, datetime

from ..brokers.metatrader import MetaTraderClient
from ..config import settings
from ..encryption import decrypt
from ..supabase_client import get_service_client
from . import rules
from .watchlist import get_active_watchlist_symbols

logger = logging.getLogger("broker_sync")

# watchlist_symbols.timeframe ('M1'/'M5'/'M15'/'H1'/'H4') to MetaApi's own
# historical-market-data timeframe string format.
_METAAPI_TIMEFRAME = {
    "M1": "1m",
    "M5": "5m",
    "M15": "15m",
    "H1": "1h",
    "H4": "4h",
}

CANDLE_FETCH_LIMIT = 200


async def scan_setups() -> None:
    supabase = get_service_client()

    symbols = await get_active_watchlist_symbols(supabase)
    if not symbols:
        logger.info("scan_setups: no active watchlist symbols — nothing to scan.")
        return

    client = await _get_market_data_client(supabase)
    if client is None:
        logger.warning(
            "scan_setups: no healthy MetaTrader connection available to fetch candles from — skipping cycle."
        )
        return

    try:
        for entry in symbols:
            try:
                await _scan_symbol(supabase, client, entry)
            except Exception:
                logger.exception(
                    "scan_setups: failed to scan symbol=%s timeframe=%s",
                    entry.get("symbol"),
                    entry.get("timeframe"),
                )
    finally:
        await client.aclose()


async def _get_market_data_client(supabase) -> MetaTraderClient | None:
    result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .select("*")
        .eq("broker", "metatrader")
        .neq("health", "closed")
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return None

    connection = rows[0]
    mt_password = decrypt(connection["encrypted_mt_password"], connection["mt_password_iv"])
    return MetaTraderClient(
        login=connection["mt_login"],
        password=mt_password,
        server=connection["mt_server"],
        platform=connection["mt_platform"],
        metaapi_token=settings.metaapi_token,
        account_id=connection.get("metaapi_account_id"),
        region=connection.get("metaapi_region"),
    )


async def _scan_symbol(supabase, client: MetaTraderClient, entry: dict) -> None:
    symbol = entry["symbol"]
    timeframe = entry["timeframe"]
    metaapi_timeframe = _METAAPI_TIMEFRAME.get(timeframe)
    if metaapi_timeframe is None:
        logger.warning("scan_setups: unsupported timeframe=%s for symbol=%s — skipping.", timeframe, symbol)
        return

    raw_candles = await client.get_candles(symbol, metaapi_timeframe, limit=CANDLE_FETCH_LIMIT)
    candles = _normalize_candles(raw_candles)
    if len(candles) < 2:
        return

    # The most recent candle from a historical-market-data fetch may still
    # be forming (MetaApi includes the current, unclosed candle) — drop it
    # so every detector in rules.py only ever evaluates closed candles.
    # Without this, a detection would fire and re-fire on every partial
    # tick of the same still-open candle.
    closed_candles = candles[:-1]
    if len(closed_candles) < 2:
        return

    detections = rules.detect_all(closed_candles)
    if not detections:
        return

    rows = [
        {
            "symbol": symbol,
            "timeframe": timeframe,
            "structure_type": d["structure_type"],
            "direction": d["direction"],
            "entry_zone_low": d["entry_zone_low"],
            "entry_zone_high": d["entry_zone_high"],
            "stop_loss": d["stop_loss"],
            "take_profit": d["take_profit"],
            "risk_reward_ratio": d["risk_reward_ratio"],
            "candle_timestamp": d["candle_timestamp"].isoformat(),
            "raw_detection": d["raw_detection"],
        }
        for d in detections
    ]

    # ignore_duplicates=True — ON CONFLICT DO NOTHING, not DO UPDATE. A
    # detection re-firing for a candle that's already been scored must
    # never resurrect it back to pending_scoring by overwriting the row;
    # the unique constraint on (symbol, timeframe, structure_type,
    # candle_timestamp) is purely an idempotency guard here, not an
    # update mechanism.
    await asyncio.to_thread(
        lambda: supabase.table("candidate_setups")
        .upsert(rows, on_conflict="symbol,timeframe,structure_type,candle_timestamp", ignore_duplicates=True)
        .execute()
    )
    logger.info("scan_setups: symbol=%s timeframe=%s produced %d candidate(s).", symbol, timeframe, len(rows))


def _normalize_candles(raw_candles: list[dict]) -> list[rules.Candle]:
    """MetaApi's MetatraderCandle shape (time/open/high/low/close/
    tickVolume, oldest first) -> this module's broker-agnostic Candle
    dict. `time` is an ISO8601 string; converted to a real datetime so
    rules.py never has to reason about string formats."""
    normalized: list[rules.Candle] = []
    for c in raw_candles:
        time_str = c["time"]
        timestamp = datetime.fromisoformat(time_str.replace("Z", "+00:00")) if isinstance(time_str, str) else time_str
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        normalized.append(
            {
                "timestamp": timestamp,
                "open": float(c["open"]),
                "high": float(c["high"]),
                "low": float(c["low"]),
                "close": float(c["close"]),
                "volume": float(c.get("tickVolume", 0)),
            }
        )
    return normalized
