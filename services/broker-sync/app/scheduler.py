import asyncio
import logging
import time
from datetime import UTC, datetime

import sentry_sdk
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .alert_engine import evaluate_all_alerts as _evaluate_all_alerts
from .config import settings
from .decision_gate.service import evaluate_decision_gate as _evaluate_decision_gate
from .fx_service import refresh_fx_rates as _refresh_fx_rates
from .managed_mode import evaluate_managed_mode as _evaluate_managed_mode
from .pantheon.hermes import run_hermes_scan as _run_hermes_scan
from .pantheon.mnemosyne import mnemosyne_daily as _mnemosyne_daily
from .pantheon.mnemosyne import mnemosyne_weekly as _mnemosyne_weekly
from .payout_detection import detect_withdrawal_events as _detect_withdrawal_events
from .portfolio_risk.service import evaluate_portfolio_risk as _evaluate_portfolio_risk
from .redis_cache import (
    acquire_alert_lock,
    acquire_decision_gate_lock,
    acquire_fx_refresh_lock,
    acquire_hermes_scan_lock,
    acquire_managed_mode_lock,
    acquire_mnemosyne_daily_lock,
    acquire_mnemosyne_weekly_lock,
    acquire_payout_detection_lock,
    acquire_poll_lock,
    acquire_portfolio_risk_lock,
    acquire_scan_lock,
    acquire_signal_scoring_lock,
    acquire_value_ledger_rollup_lock,
    acquire_wallet_reconciliation_lock,
    record_alert_evaluation_heartbeat,
    record_decision_gate_heartbeat,
    record_fx_refresh_heartbeat,
    record_hermes_scan_heartbeat,
    record_managed_mode_evaluation_heartbeat,
    record_mnemosyne_daily_heartbeat,
    record_mnemosyne_weekly_heartbeat,
    record_payout_detection_heartbeat,
    record_poll_heartbeat,
    record_portfolio_risk_heartbeat,
    record_scan_heartbeat,
    record_signal_scoring_heartbeat,
    record_value_ledger_rollup_heartbeat,
    record_wallet_reconciliation_heartbeat,
    release_alert_lock,
    release_decision_gate_lock,
    release_fx_refresh_lock,
    release_hermes_scan_lock,
    release_managed_mode_lock,
    release_mnemosyne_daily_lock,
    release_mnemosyne_weekly_lock,
    release_payout_detection_lock,
    release_poll_lock,
    release_portfolio_risk_lock,
    release_scan_lock,
    release_signal_scoring_lock,
    release_value_ledger_rollup_lock,
    release_wallet_reconciliation_lock,
)
from .scanner.service import scan_setups as _scan_setups
from .signal_engine.service import score_pending_candidates as _score_pending_candidates
from .supabase_client import get_service_client
from .sync_service import BROKER_CLIENTS, sync_connection
from .value_ledger_rollup import compute_rollups as _compute_value_ledger_rollups
from .wallet_reconciliation import reconcile_wallet_transactions as _reconcile_wallet_transactions

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
        now_iso = datetime.now(UTC).isoformat()

        # Bybit first, then Binance, then KuCoin, then MetaTrader — follows
        # BROKER_CLIENTS' insertion order.
        #
        # Connection Health & Data Freshness: health is now authoritative
        # (sync_status is a derived, backward-compatible view — see
        # sync_service.py's _DERIVED_SYNC_STATUS) and next_attempt_at
        # implements per-connection backoff — a connection that's
        # currently backed off (or auth_failed/prop_breached, which use a
        # long fixed interval) or closed costs nothing in a poll cycle.
        # The `.neq('health', 'closed')` filter matches
        # broker_connections_poll_idx's partial-index predicate exactly
        # so this can actually use that index rather than falling back to
        # a full scan.
        for broker in BROKER_CLIENTS:
            result = await asyncio.to_thread(
                lambda b=broker.value: supabase.table("broker_connections")
                .select("*")
                .eq("broker", b)
                .neq("health", "closed")
                .lte("next_attempt_at", now_iso)
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


async def reconcile_wallet_transactions() -> None:
    """Same lock/heartbeat/logging shape as the other three jobs, for the
    nightly wallet ledger vs. Paystack/Stripe diff — see
    wallet_reconciliation.py for the actual comparison logic."""
    if not await acquire_wallet_reconciliation_lock():
        logger.info("Another instance already holds the wallet reconciliation lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("reconcile_wallet_transactions: started")

    try:
        await _reconcile_wallet_transactions()
        await record_wallet_reconciliation_heartbeat()
    except Exception:
        logger.exception("reconcile_wallet_transactions: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("reconcile_wallet_transactions: finished in %.2fs", duration_seconds)
        await release_wallet_reconciliation_lock()


async def refresh_fx_rates() -> None:
    """Same lock/heartbeat/logging shape as the other four jobs — see
    fx_service.py for the actual CoinGecko/Open Exchange Rates fetch."""
    if not await acquire_fx_refresh_lock():
        logger.info("Another instance already holds the FX refresh lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("refresh_fx_rates: started")

    try:
        await _refresh_fx_rates()
        await record_fx_refresh_heartbeat()
    except Exception:
        logger.exception("refresh_fx_rates: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("refresh_fx_rates: finished in %.2fs", duration_seconds)
        await release_fx_refresh_lock()


async def run_hermes_scan() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    pantheon/hermes.py for the actual CoinGecko screen + cool-down gate."""
    if not await acquire_hermes_scan_lock():
        logger.info("Another instance already holds the Hermes scan lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("run_hermes_scan: started")

    try:
        await _run_hermes_scan()
        await record_hermes_scan_heartbeat()
    except Exception:
        logger.exception("run_hermes_scan: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("run_hermes_scan: finished in %.2fs", duration_seconds)
        await release_hermes_scan_lock()


async def run_mnemosyne_daily() -> None:
    """Same lock/heartbeat/logging shape as the other jobs, cron-triggered
    (see pantheon/mnemosyne.py's module docstring for why)."""
    if not await acquire_mnemosyne_daily_lock():
        logger.info("Another instance already holds the Mnemosyne daily lock — skipping this run.")
        return

    started_at = time.monotonic()
    logger.info("run_mnemosyne_daily: started")

    try:
        await _mnemosyne_daily()
        await record_mnemosyne_daily_heartbeat()
    except Exception:
        logger.exception("run_mnemosyne_daily: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("run_mnemosyne_daily: finished in %.2fs", duration_seconds)
        await release_mnemosyne_daily_lock()


async def run_mnemosyne_weekly() -> None:
    """Same lock/heartbeat/logging shape as the other jobs, cron-triggered."""
    if not await acquire_mnemosyne_weekly_lock():
        logger.info("Another instance already holds the Mnemosyne weekly lock — skipping this run.")
        return

    started_at = time.monotonic()
    logger.info("run_mnemosyne_weekly: started")

    try:
        await _mnemosyne_weekly()
        await record_mnemosyne_weekly_heartbeat()
    except Exception:
        logger.exception("run_mnemosyne_weekly: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("run_mnemosyne_weekly: finished in %.2fs", duration_seconds)
        await release_mnemosyne_weekly_lock()


async def run_value_ledger_rollup() -> None:
    """Same lock/heartbeat/logging shape as the other jobs, cron-triggered
    (needs wall-clock alignment, same reasoning as Mnemosyne — see its
    module docstring). Registered 10 minutes after run_mnemosyne_daily so
    this job's own Aria-finding write doesn't race Mnemosyne's daily
    narration for the same user."""
    if not await acquire_value_ledger_rollup_lock():
        logger.info("Another instance already holds the value-ledger-rollup lock — skipping this run.")
        return

    started_at = time.monotonic()
    logger.info("run_value_ledger_rollup: started")

    try:
        await _compute_value_ledger_rollups()
        await record_value_ledger_rollup_heartbeat()
    except Exception:
        logger.exception("run_value_ledger_rollup: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("run_value_ledger_rollup: finished in %.2fs", duration_seconds)
        await release_value_ledger_rollup_lock()


async def scan_setups() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    scanner/service.py for the actual candle fetch + SMC rules engine
    (PRD Sprint 1, component 4A)."""
    if not await acquire_scan_lock():
        logger.info("Another instance already holds the scan lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("scan_setups: started")

    try:
        await _scan_setups()
        await record_scan_heartbeat()
    except Exception:
        logger.exception("scan_setups: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("scan_setups: finished in %.2fs", duration_seconds)
        await release_scan_lock()


async def score_signals() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    signal_engine/service.py for the actual Claude scoring call (PRD
    Sprint 2, component 4B)."""
    if not await acquire_signal_scoring_lock():
        logger.info("Another instance already holds the signal scoring lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("score_signals: started")

    try:
        await _score_pending_candidates()
        await record_signal_scoring_heartbeat()
    except Exception:
        logger.exception("score_signals: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("score_signals: finished in %.2fs", duration_seconds)
        await release_signal_scoring_lock()


async def evaluate_portfolio_risk() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    portfolio_risk/service.py for the actual exposure aggregation +
    circuit-breaker logic (vaultpoint-quant-trading-desk-spec.pdf §4).
    Registered to run BEFORE evaluate_decision_gate, both in this file's
    ordering and in start_scheduler()'s add_job calls below —
    evaluate_decision_gate reads this job's output synchronously every
    cycle and must never read stale-from-before-this-deploy state."""
    if not await acquire_portfolio_risk_lock():
        logger.info("Another instance already holds the portfolio risk lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("evaluate_portfolio_risk: started")

    try:
        await _evaluate_portfolio_risk()
        await record_portfolio_risk_heartbeat()
    except Exception:
        logger.exception("evaluate_portfolio_risk: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("evaluate_portfolio_risk: finished in %.2fs", duration_seconds)
        await release_portfolio_risk_lock()


async def evaluate_decision_gate() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    decision_gate/service.py for the actual per-account routing (PRD
    Sprint 3, component 4C)."""
    if not await acquire_decision_gate_lock():
        logger.info("Another instance already holds the decision gate lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("evaluate_decision_gate: started")

    try:
        await _evaluate_decision_gate()
        await record_decision_gate_heartbeat()
    except Exception:
        logger.exception("evaluate_decision_gate: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("evaluate_decision_gate: finished in %.2fs", duration_seconds)
        await release_decision_gate_lock()


async def detect_withdrawal_events() -> None:
    """Same lock/heartbeat/logging shape as the other jobs — see
    payout_detection.py for the actual balance-snapshot diff + heuristic
    (Automated Profit-Split Payout Calculation spec, section 3.1)."""
    if not await acquire_payout_detection_lock():
        logger.info("Another instance already holds the payout detection lock — skipping this cycle.")
        return

    started_at = time.monotonic()
    logger.info("detect_withdrawal_events: started")

    try:
        await _detect_withdrawal_events()
        await record_payout_detection_heartbeat()
    except Exception:
        logger.exception("detect_withdrawal_events: failed")
        sentry_sdk.capture_exception()
        raise
    finally:
        duration_seconds = time.monotonic() - started_at
        logger.info("detect_withdrawal_events: finished in %.2fs", duration_seconds)
        await release_payout_detection_lock()


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
    scheduler.add_job(
        reconcile_wallet_transactions,
        "interval",
        seconds=settings.wallet_reconciliation_interval_seconds,
        id="reconcile_wallet_transactions",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        refresh_fx_rates,
        "interval",
        seconds=settings.fx_refresh_interval_seconds,
        id="refresh_fx_rates",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        run_hermes_scan,
        "interval",
        seconds=settings.hermes_scan_interval_seconds,
        id="run_hermes_scan",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        run_mnemosyne_daily,
        "cron",
        hour=0,
        minute=0,
        id="run_mnemosyne_daily",
        max_instances=1,
    )
    scheduler.add_job(
        run_mnemosyne_weekly,
        "cron",
        day_of_week="mon",
        hour=0,
        minute=5,  # offset from the daily job so they don't contend for the same user's data on Mondays
        id="run_mnemosyne_weekly",
        max_instances=1,
    )
    scheduler.add_job(
        run_value_ledger_rollup,
        "cron",
        hour=0,
        minute=10,  # after run_mnemosyne_daily so its own Aria-finding write doesn't race Mnemosyne's
        id="run_value_ledger_rollup",
        max_instances=1,
    )
    scheduler.add_job(
        scan_setups,
        "interval",
        seconds=settings.scanner_interval_seconds,
        id="scan_setups",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        score_signals,
        "interval",
        seconds=settings.signal_engine_interval_seconds,
        id="score_signals",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        evaluate_portfolio_risk,
        "interval",
        seconds=settings.portfolio_risk_interval_seconds,
        id="evaluate_portfolio_risk",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        evaluate_decision_gate,
        "interval",
        seconds=settings.decision_gate_interval_seconds,
        id="evaluate_decision_gate",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.add_job(
        detect_withdrawal_events,
        "interval",
        seconds=settings.payout_detection_interval_seconds,
        id="detect_withdrawal_events",
        next_run_time=datetime.now(),
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        "Scheduler started — polling every %ss, evaluating alerts every %ss, "
        "evaluating managed mode every %ss, reconciling wallet transactions every %ss, "
        "refreshing FX rates every %ss, scanning Hermes opportunities every %ss, "
        "Mnemosyne daily at 00:00 and weekly Monday 00:05, scanning SMC setups every %ss, "
        "scoring signals every %ss, evaluating portfolio risk every %ss, "
        "evaluating the decision gate every %ss, detecting withdrawal events every %ss.",
        settings.poll_interval_seconds,
        settings.alert_evaluation_interval_seconds,
        settings.managed_mode_evaluation_interval_seconds,
        settings.wallet_reconciliation_interval_seconds,
        settings.fx_refresh_interval_seconds,
        settings.hermes_scan_interval_seconds,
        settings.scanner_interval_seconds,
        settings.signal_engine_interval_seconds,
        settings.portfolio_risk_interval_seconds,
        settings.decision_gate_interval_seconds,
        settings.payout_detection_interval_seconds,
    )
