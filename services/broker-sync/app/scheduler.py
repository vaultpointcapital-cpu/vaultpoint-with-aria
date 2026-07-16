import asyncio
import logging
import time
from datetime import datetime

import sentry_sdk
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .config import settings
from .redis_cache import acquire_poll_lock, record_poll_heartbeat, release_poll_lock
from .supabase_client import get_service_client
from .sync_service import BROKER_CLIENTS, sync_connection

logger = logging.getLogger("broker_sync")
scheduler = AsyncIOScheduler()


async def poll_all_connections() -> None:
    # Railway's zero-downtime deploys briefly run the old and new instance
    # together, each with their own APScheduler on the same interval —
    # without this lock, both would poll every connection independently
    # during that overlap window. max_instances=1 below only prevents a
    # single process from overlapping ITS OWN runs; it does nothing across
    # processes, which is what this guards against. Replicas are also
    # pinned to 1 in Railway's config, but this lock is the real guarantee
    # — the pin only limits steady-state, not the deploy transition.
    if not await acquire_poll_lock():
        logger.info("Another instance already holds the poll lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("poll_all_connections: started")

    try:
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
        # connections synced cleanly (their own failures are recorded on
        # their row), so it reflects "the scheduler is alive and completing
        # cycles," not "every broker is currently reachable."
        await record_poll_heartbeat()
    except Exception:
        # sync_connection() catches its own per-connection failures and
        # never raises past itself — anything reaching here is a failure
        # in the CYCLE itself (Supabase/Redis unreachable, a bug), which
        # is exactly what should page someone, not get silently retried
        # next cycle. Re-raised after capturing so APScheduler's own
        # error logging for the job isn't lost.
        logger.exception("poll_all_connections: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("poll_all_connections: finished in %.2fs", duration_seconds)
        await release_poll_lock()


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
