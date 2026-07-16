import asyncio
import logging
from datetime import date, datetime, timezone
from typing import Type

from .brokers.base import BrokerClient
from .brokers.bybit import BybitClient
from .encryption import decrypt
from .financial import calculate_position_value
from .models import BrokerType
from .redis_cache import cache_positions
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

# Bybit first, then Binance, then KuCoin, then MetaTrader (via MetaApi) —
# insertion order here is poll order. Adding a broker later means
# registering it here; nothing else in the sync/scheduler path branches
# on broker name. Keys are BrokerType members, not raw strings, so a
# typo'd broker name is an AttributeError at import time, not a client
# that silently never matches any connection.
BROKER_CLIENTS: dict[BrokerType, Type[BrokerClient]] = {
    BrokerType.BYBIT: BybitClient,
}

CRYPTO_BROKERS = {BrokerType.BYBIT, BrokerType.BINANCE, BrokerType.KUCOIN}


async def sync_connection(connection: dict) -> None:
    """One broker_connections row -> live broker fetch -> normalize ->
    cache -> Supabase upsert. Never raises past this point: a failure on
    one connection is recorded on that row and logged, not propagated, so
    it can't take down the rest of a poll cycle.
    """
    supabase = get_service_client()
    connection_id = connection["id"]
    user_id = connection["user_id"]

    try:
        broker = BrokerType(connection["broker"])
    except ValueError:
        logger.error(
            "connection=%s has broker=%r, which isn't a BrokerType member — "
            "check constraint drift between the migration and models.py?",
            connection_id,
            connection["broker"],
        )
        return

    client_cls = BROKER_CLIENTS.get(broker)
    if client_cls is None:
        logger.debug(
            "No BrokerClient registered yet for broker=%s (connection=%s) — skipping.",
            broker.value,
            connection_id,
        )
        return

    try:
        api_key = decrypt(connection["encrypted_api_key"], connection["api_key_iv"])
        api_secret = decrypt(connection["encrypted_api_secret"], connection["api_secret_iv"])
    except Exception:
        logger.exception("Failed to decrypt credentials for connection=%s", connection_id)
        await _mark_error(supabase, connection_id, "Could not decrypt stored credentials.")
        return

    client = client_cls(api_key, api_secret)
    try:
        positions = await client.get_positions()
    except Exception as exc:
        # Keep last known data — don't wipe positions, don't touch
        # last_synced_at. Only the error/status fields change.
        logger.warning("Broker sync failed for connection=%s (%s): %s", connection_id, broker.value, exc)
        await _mark_error(supabase, connection_id, str(exc)[:500])
        return
    finally:
        await client.aclose()

    rows = [
        {
            "user_id": user_id,
            "broker_connection_id": connection_id,
            "symbol": p.symbol,
            "side": p.side,
            "size": p.size,
            "entry_price": p.entry_price,
            "mark_price": p.mark_price,
            "leverage": p.leverage,
            "unrealized_pnl": p.unrealized_pnl,
            "unrealized_pnl_pct": p.unrealized_pnl_pct,
            "margin_used": p.margin_used,
        }
        for p in positions
    ]

    await cache_positions(connection_id, rows)
    await asyncio.to_thread(_reconcile_positions, supabase, connection_id, rows)
    await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .update(
            {
                "sync_status": "connected",
                "last_synced_at": datetime.now(timezone.utc).isoformat(),
                "last_error": None,
            }
        )
        .eq("id", connection_id)
        .execute()
    )

    await asyncio.to_thread(_upsert_portfolio_snapshot, supabase, user_id)


def _reconcile_positions(supabase, connection_id: str, rows: list[dict]) -> None:
    """positions is "replaced/upserted on each poll cycle, not an
    append-only log" per the migration's own comment — so anything no
    longer reported by the broker gets deleted, not left stale forever.
    """
    open_keys = {(r["symbol"], r["side"]) for r in rows}

    existing = (
        supabase.table("positions")
        .select("id, symbol, side")
        .eq("broker_connection_id", connection_id)
        .execute()
    )
    stale_ids = [row["id"] for row in existing.data if (row["symbol"], row["side"]) not in open_keys]
    if stale_ids:
        supabase.table("positions").delete().in_("id", stale_ids).execute()

    if rows:
        supabase.table("positions").upsert(rows, on_conflict="broker_connection_id,symbol,side").execute()


async def _mark_error(supabase, connection_id: str, message: str) -> None:
    await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .update({"sync_status": "error", "last_error": message})
        .eq("id", connection_id)
        .execute()
    )


def _upsert_portfolio_snapshot(supabase, user_id: str) -> None:
    """portfolio_snapshots is documented (migration comment + the hand
    written Update: never type) as an append-only, once-daily snapshot —
    NOT something this poll cycle should overwrite every 60s. So this
    only ever INSERTs the first time a given (user_id, today) row is
    missing; if today's snapshot already exists, it's left untouched.
    Flagged to the user: the spec asked to "upsert" this table on every
    poll, which would break that append-only invariant — this is the
    conservative reading until that's explicitly confirmed.
    """
    today = str(date.today())

    existing = (
        supabase.table("portfolio_snapshots")
        .select("id")
        .eq("user_id", user_id)
        .eq("snapshot_date", today)
        .execute()
    )
    if existing.data:
        return

    positions_result = (
        supabase.table("positions")
        .select("size, mark_price, entry_price, broker_connections(broker)")
        .eq("user_id", user_id)
        .execute()
    )
    manual_result = supabase.table("manual_assets").select("value").eq("user_id", user_id).execute()

    crypto_value = 0.0
    forex_value = 0.0
    for p in positions_result.data:
        value = calculate_position_value(p["mark_price"], p["entry_price"], p["size"])
        broker_info = p.get("broker_connections")
        if isinstance(broker_info, list):
            broker_info = broker_info[0] if broker_info else None
        broker = (broker_info or {}).get("broker")
        if broker in CRYPTO_BROKERS:
            crypto_value += value
        else:
            forex_value += value

    manual_value = sum(a["value"] for a in manual_result.data)
    total_net_worth = crypto_value + forex_value + manual_value

    supabase.table("portfolio_snapshots").insert(
        {
            "user_id": user_id,
            "total_net_worth": total_net_worth,
            "crypto_value": crypto_value,
            "forex_value": forex_value,
            "manual_assets_value": manual_value,
            "snapshot_date": today,
        }
    ).execute()
