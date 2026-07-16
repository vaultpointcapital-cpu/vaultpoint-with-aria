import asyncio
import logging
from datetime import UTC, date, datetime

from .brokers.base import BrokerClient
from .brokers.binance import BinanceClient
from .brokers.bybit import BybitClient
from .brokers.kucoin import KucoinClient
from .brokers.metatrader import MetaTraderClient
from .config import settings
from .encryption import decrypt
from .financial import calculate_position_value
from .models import BrokerType
from .redis_cache import cache_positions
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

# Bybit first, then Binance, then KuCoin, then MetaTrader (via MetaApi) —
# insertion order here is poll order. Adding a broker later means
# registering it here; nothing else in the sync/scheduler path branches
# on broker name — EXCEPT MetaTraderClient's construction below, which is
# a disclosed exception: MetaTrader's credentials (login/password/server
# + a service-level MetaApi token) don't fit the api_key/api_secret shape
# every other client uses, and it needs a lazy provisioning step the
# others don't. Keys are BrokerType members, not raw strings, so a
# typo'd broker name is an AttributeError at import time, not a client
# that silently never matches any connection.
BROKER_CLIENTS: dict[BrokerType, type[BrokerClient]] = {
    BrokerType.BYBIT: BybitClient,
    BrokerType.BINANCE: BinanceClient,
    BrokerType.KUCOIN: KucoinClient,
    BrokerType.METATRADER: MetaTraderClient,
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

    if broker is BrokerType.METATRADER:
        client = await _build_metatrader_client(supabase, connection)
    else:
        client = await _build_signed_client(supabase, client_cls, connection)

    if client is None:
        # Error already recorded on the row by the builder above.
        return

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
                "last_synced_at": datetime.now(UTC).isoformat(),
                "last_error": None,
            }
        )
        .eq("id", connection_id)
        .execute()
    )

    await asyncio.to_thread(_upsert_portfolio_snapshot, supabase, user_id)


async def _build_signed_client(
    supabase, client_cls: type[BrokerClient], connection: dict
) -> BrokerClient | None:
    """Bybit/Binance/KuCoin all authenticate the same way: decrypt
    api_key/api_secret(/api_passphrase), construct the client. Returns
    None (with the row already marked as errored) on any failure.
    """
    connection_id = connection["id"]

    try:
        api_key = decrypt(connection["encrypted_api_key"], connection["api_key_iv"])
        api_secret = decrypt(connection["encrypted_api_secret"], connection["api_secret_iv"])
        api_passphrase = None
        if connection.get("encrypted_api_passphrase") and connection.get("api_passphrase_iv"):
            api_passphrase = decrypt(
                connection["encrypted_api_passphrase"], connection["api_passphrase_iv"]
            )
    except Exception:
        logger.exception("Failed to decrypt credentials for connection=%s", connection_id)
        await _mark_error(supabase, connection_id, "Could not decrypt stored credentials.")
        return None

    try:
        return client_cls(api_key, api_secret, api_passphrase=api_passphrase)
    except Exception as exc:
        # e.g. a KuCoin row that somehow reached here without a passphrase
        # despite the DB check constraint — construction failing loudly
        # here beats a confusing failure deeper inside get_positions().
        logger.exception("Failed to construct broker client for connection=%s", connection_id)
        await _mark_error(supabase, connection_id, str(exc)[:500])
        return None


async def _build_metatrader_client(supabase, connection: dict) -> MetaTraderClient | None:
    """MetaTrader needs the service-level METAAPI_TOKEN plus a decrypted
    MT password, and — unlike the other three — a lazily-provisioned
    MetaApi cloud terminal before it can serve any data at all. On a
    connection's first sync this provisions (create + deploy + wait for
    CONNECTED) and persists the resulting metaapi_account_id/region back
    to the row so subsequent polls skip straight to querying. Returns
    None (with the row already marked as errored) on any failure.
    """
    connection_id = connection["id"]

    if not settings.metaapi_token:
        logger.error("METAAPI_TOKEN is not configured — cannot sync connection=%s", connection_id)
        await _mark_error(supabase, connection_id, "MetaTrader support is not configured on this server.")
        return None

    try:
        mt_password = decrypt(connection["encrypted_mt_password"], connection["mt_password_iv"])
    except Exception:
        logger.exception("Failed to decrypt MT password for connection=%s", connection_id)
        await _mark_error(supabase, connection_id, "Could not decrypt stored credentials.")
        return None

    client = MetaTraderClient(
        login=connection["mt_login"],
        password=mt_password,
        server=connection["mt_server"],
        platform=connection["mt_platform"],
        metaapi_token=settings.metaapi_token,
        account_id=connection.get("metaapi_account_id"),
        region=connection.get("metaapi_region"),
    )

    if client.account_id is None or client.region is None:
        try:
            await client.provision()
        except Exception as exc:
            logger.warning("MetaApi provisioning failed for connection=%s: %s", connection_id, exc)
            await _mark_error(supabase, connection_id, str(exc)[:500])
            await client.aclose()
            return None

        await asyncio.to_thread(
            lambda: supabase.table("broker_connections")
            .update({"metaapi_account_id": client.account_id, "metaapi_region": client.region})
            .eq("id", connection_id)
            .execute()
        )

    return client


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
