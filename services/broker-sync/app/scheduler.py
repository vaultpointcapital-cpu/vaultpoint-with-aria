import asyncio
import logging
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .config import settings
from .redis_cache import record_poll_heartbeat
from .supabase_client import get_service_client
from .sync_service import BROKER_CLIENTS, sync_connection

logger = logging.getLogger("broker_sync")
scheduler = AsyncIOScheduler()


async def poll_all_connections() -> None:
    supabase = get_service_client()

    # Bybit first, then Binance, then KuCoin, then MetaTrader — follows
    # BROKER_CLIENTS' insertion order.
    for broker in BROKER_CLIENTS:
        result = await asyncio.to_thread(
            lambda b=broker.value: supabase.table("broker_connections")
            .select("*")
            .eq("broker", b)
            .neq("sync_status", "disconnected")
            .execute()
        )
        for connection in result.data:
            await sync_connection(connection)

    # Liveness signal for /health — this fires whether or not individual
    # connections synced cleanly (their own failures are recorded on their
    # row), so it reflects "the scheduler is alive and completing cycles,"
    # not "every broker is currently reachable."
    await record_poll_heartbeat()


def start_scheduler() -> None:
    scheduler.add_job(
        poll_all_connections,
        "interval",
        seconds=settings.poll_interval_seconds,
        id="poll_all_connections",
        next_run_time=datetime.now(),  # run once immediately, then every interval
        max_instances=1,  # don't start a new poll if the previous one is still running
    )
    scheduler.start()
    logger.info("Scheduler started — polling every %ss.", settings.poll_interval_seconds)
