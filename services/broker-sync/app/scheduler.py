import asyncio
import logging
import time
from datetime import datetime

import sentry_sdk
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .alert_engine import evaluate_all_alerts as _evaluate_all_alerts
from .config import settings
from .managed_mode import evaluate_managed_mode as _evaluate_managed_mode
from .redis_cache import (
    acquire_alert_lock,
    acquire_managed_mode_lock,
    acquire_poll_lock,
    record_alert_evaluation_heartbeat,
    record_managed_mode_evaluation_heartbeat,
    record_poll_heartbeat,
    release_alert_lock,
    release_managed_mode_lock,
    release_poll_lock,
)
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


async def evaluate_all_alerts() -> None:
    """Same lock/heartbeat/logging shape as poll_all_connections, for the
    Alert Engine's independent job — see acquire_alert_lock's docstring
    for why this uses its own lock key rather than sharing the poll
    lock."""
    if not await acquire_alert_lock():
        logger.info("Another instance already holds the alert lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("evaluate_all_alerts: started")

    try:
        await _evaluate_all_alerts()
        await record_alert_evaluation_heartbeat()
    except Exception:
        logger.exception("evaluate_all_alerts: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("evaluate_all_alerts: finished in %.2fs", duration_seconds)
        await release_alert_lock()


async def evaluate_managed_mode() -> None:
    """Same lock/heartbeat/logging shape as the other two jobs. This is
    the highest-stakes cycle in the service — see managed_mode.py's
    module docstring — but the operational safety net (single-instance
    lock during deploy overlaps, liveness heartbeat, log-and-continue on
    a cycle-level failure) is identical to poll_all_connections and
    evaluate_all_alerts, not something this job needs its own variant of.
    """
    if not await acquire_managed_mode_lock():
        logger.info("Another instance already holds the managed mode lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("evaluate_managed_mode: started")

    try:
        await _evaluate_managed_mode()
        await record_managed_mode_evaluation_heartbeat()
    except Exception:
        logger.exception("evaluate_managed_mode: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("evaluate_managed_mode: finished in %.2fs", duration_seconds)
        await release_managed_mode_lock()


def start_scheduler() -> None:
    scheduler.add_job(
        poll_all_connections,
        "interval",
        seconds=settings.poll_interval_seconds,
        id="poll_all_connections",
        next_run_time=datetime.now(),  # run once immediately, then every interval
        max_instances=1,  # don't start a new poll if the previous one is still running
    )
    scheduler.add_job(
        evaluate_all_alerts,
        "interval",
        seconds=settings.alert_evaluation_interval_seconds,
        id="evaluate_all_alerts",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        evaluate_managed_mode,
        "interval",
        seconds=settings.managed_mode_evaluation_interval_seconds,
        id="evaluate_managed_mode",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        "Scheduler started — polling every %ss, evaluating alerts every %ss, "
        "evaluating managed mode every %ss.",
        settings.poll_interval_seconds,
        settings.alert_evaluation_interval_seconds,
        settings.managed_mode_evaluation_interval_seconds,
    )
