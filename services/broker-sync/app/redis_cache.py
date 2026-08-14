import json
from datetime import UTC, datetime

from upstash_redis.asyncio import Redis

from .config import settings

_redis = Redis(url=settings.upstash_redis_rest_url, token=settings.upstash_redis_rest_token)

LAST_POLL_KEY = "health:last_successful_poll"
LAST_ALERT_EVAL_KEY = "health:last_alert_evaluation"
LAST_MANAGED_MODE_EVAL_KEY = "health:last_managed_mode_evaluation"
POLL_LOCK_KEY = "lock:poll_all_connections"
ALERT_LOCK_KEY = "lock:evaluate_all_alerts"
MANAGED_MODE_LOCK_KEY = "lock:evaluate_managed_mode"
LAST_WALLET_RECONCILIATION_KEY = "health:last_wallet_reconciliation"
WALLET_RECONCILIATION_LOCK_KEY = "lock:reconcile_wallet_transactions"
LAST_FX_REFRESH_KEY = "health:last_fx_refresh"
FX_REFRESH_LOCK_KEY = "lock:refresh_fx_rates"
LAST_HERMES_SCAN_KEY = "health:last_hermes_scan"
HERMES_SCAN_LOCK_KEY = "lock:run_hermes_scan"
LAST_MNEMOSYNE_DAILY_KEY = "health:last_mnemosyne_daily"
MNEMOSYNE_DAILY_LOCK_KEY = "lock:run_mnemosyne_daily"
LAST_MNEMOSYNE_WEEKLY_KEY = "health:last_mnemosyne_weekly"
MNEMOSYNE_WEEKLY_LOCK_KEY = "lock:run_mnemosyne_weekly"
LAST_SCAN_KEY = "health:last_scan_setups"
SCAN_LOCK_KEY = "lock:scan_setups"
LAST_SIGNAL_SCORING_KEY = "health:last_signal_scoring"
SIGNAL_SCORING_LOCK_KEY = "lock:score_signals"
LAST_DECISION_GATE_KEY = "health:last_decision_gate"
DECISION_GATE_LOCK_KEY = "lock:evaluate_decision_gate"
LAST_VALUE_LEDGER_ROLLUP_KEY = "health:last_value_ledger_rollup"
VALUE_LEDGER_ROLLUP_LOCK_KEY = "lock:run_value_ledger_rollup"
LAST_PAYOUT_DETECTION_KEY = "health:last_payout_detection"
PAYOUT_DETECTION_LOCK_KEY = "lock:detect_withdrawal_events"
LAST_PORTFOLIO_RISK_KEY = "health:last_portfolio_risk"
PORTFOLIO_RISK_LOCK_KEY = "lock:evaluate_portfolio_risk"
# Cron-triggered jobs (Mnemosyne) don't have a fixed "interval" setting to
# size their lock TTL off of — a flat cap comfortably longer than either
# job should ever take, same purpose as POLL_LOCK_TTL_BUFFER_SECONDS for
# the interval-triggered jobs.
CRON_LOCK_TTL_SECONDS = 1800
# Safety margin above a normal cycle's expected duration. The lock is
# explicitly released at the end of a well-behaved cycle (see
# release_poll_lock) — this TTL only matters if a holder crashes or hangs
# without reaching that release, so it doesn't deadlock future cycles.
POLL_LOCK_TTL_BUFFER_SECONDS = 30


async def cache_positions(connection_id: str, rows: list[dict]) -> None:
    await _redis.set(f"positions:{connection_id}", json.dumps(rows), ex=settings.cache_ttl_seconds)


async def get_cached_positions(connection_id: str) -> list[dict] | None:
    raw = await _redis.get(f"positions:{connection_id}")
    return json.loads(raw) if raw else None


async def record_poll_heartbeat() -> None:
    """Marks that a poll cycle just completed. No TTL — a missing value
    means "never polled," which /health should always be able to tell
    apart from "polled a while ago."
    """
    await _redis.set(LAST_POLL_KEY, datetime.now(UTC).isoformat())


async def get_last_poll_heartbeat() -> str | None:
    return await _redis.get(LAST_POLL_KEY)


async def record_alert_evaluation_heartbeat() -> None:
    """Same shape as record_poll_heartbeat, for the Alert Engine's own
    cycle — kept as a distinct key since the two jobs run independently
    and a stale one shouldn't be masked by the other still being fresh.
    """
    await _redis.set(LAST_ALERT_EVAL_KEY, datetime.now(UTC).isoformat())


async def get_last_alert_evaluation_heartbeat() -> str | None:
    return await _redis.get(LAST_ALERT_EVAL_KEY)


def get_redis() -> Redis:
    """Shared client for anything else (e.g. the rate limiter) that needs
    direct Redis access without importing the module-private `_redis`."""
    return _redis


async def acquire_poll_lock() -> bool:
    """SET NX so only one instance's poll_all_connections() actually runs
    a given cycle. Needed because Railway's zero-downtime deploys briefly
    run the old and new instance together — without this, both would
    independently poll every broker connection on their own 60s
    schedules, doubling broker API calls and Supabase writes during that
    overlap window. TTL is the cycle's expected duration plus a buffer,
    not the poll interval — see POLL_LOCK_TTL_BUFFER_SECONDS.
    """
    redis = get_redis()
    ttl = settings.poll_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(POLL_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_poll_lock() -> None:
    """Frees the lock immediately after a well-behaved cycle finishes,
    rather than making the next cycle wait out the full TTL. Only ever
    call this after acquire_poll_lock() returned True — calling it
    unconditionally would let an instance that failed to acquire the
    lock delete another instance's still-active one."""
    redis = get_redis()
    await redis.delete(POLL_LOCK_KEY)


async def acquire_alert_lock() -> bool:
    """Same reasoning as acquire_poll_lock, for the alert-evaluation
    job — a separate lock key since these two scheduled jobs run
    independently and shouldn't block each other."""
    redis = get_redis()
    ttl = settings.alert_evaluation_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(ALERT_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_alert_lock() -> None:
    """Only ever call after acquire_alert_lock() returned True — see
    release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(ALERT_LOCK_KEY)


async def record_managed_mode_evaluation_heartbeat() -> None:
    await _redis.set(LAST_MANAGED_MODE_EVAL_KEY, datetime.now(UTC).isoformat())


async def get_last_managed_mode_evaluation_heartbeat() -> str | None:
    return await _redis.get(LAST_MANAGED_MODE_EVAL_KEY)


async def acquire_managed_mode_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so this,
    the highest-stakes job in the service, can never run twice
    concurrently across overlapping deploy instances."""
    redis = get_redis()
    ttl = settings.managed_mode_evaluation_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(MANAGED_MODE_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_managed_mode_lock() -> None:
    """Only ever call after acquire_managed_mode_lock() returned True —
    see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(MANAGED_MODE_LOCK_KEY)


async def record_wallet_reconciliation_heartbeat() -> None:
    await _redis.set(LAST_WALLET_RECONCILIATION_KEY, datetime.now(UTC).isoformat())


async def get_last_wallet_reconciliation_heartbeat() -> str | None:
    return await _redis.get(LAST_WALLET_RECONCILIATION_KEY)


async def acquire_wallet_reconciliation_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the
    nightly wallet reconciliation job can never run twice concurrently
    across overlapping deploy instances."""
    redis = get_redis()
    ttl = settings.wallet_reconciliation_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(WALLET_RECONCILIATION_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_wallet_reconciliation_lock() -> None:
    """Only ever call after acquire_wallet_reconciliation_lock() returned
    True — see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(WALLET_RECONCILIATION_LOCK_KEY)


async def record_fx_refresh_heartbeat() -> None:
    await _redis.set(LAST_FX_REFRESH_KEY, datetime.now(UTC).isoformat())


async def get_last_fx_refresh_heartbeat() -> str | None:
    return await _redis.get(LAST_FX_REFRESH_KEY)


async def acquire_fx_refresh_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the FX
    refresh job can never run twice concurrently across overlapping
    deploy instances."""
    redis = get_redis()
    ttl = settings.fx_refresh_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(FX_REFRESH_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_fx_refresh_lock() -> None:
    """Only ever call after acquire_fx_refresh_lock() returned True — see
    release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(FX_REFRESH_LOCK_KEY)


async def record_hermes_scan_heartbeat() -> None:
    await _redis.set(LAST_HERMES_SCAN_KEY, datetime.now(UTC).isoformat())


async def get_last_hermes_scan_heartbeat() -> str | None:
    return await _redis.get(LAST_HERMES_SCAN_KEY)


async def acquire_hermes_scan_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so
    Hermes's opportunity scan can never run twice concurrently across
    overlapping deploy instances."""
    redis = get_redis()
    ttl = settings.hermes_scan_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(HERMES_SCAN_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_hermes_scan_lock() -> None:
    """Only ever call after acquire_hermes_scan_lock() returned True —
    see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(HERMES_SCAN_LOCK_KEY)


async def record_mnemosyne_daily_heartbeat() -> None:
    await _redis.set(LAST_MNEMOSYNE_DAILY_KEY, datetime.now(UTC).isoformat())


async def get_last_mnemosyne_daily_heartbeat() -> str | None:
    return await _redis.get(LAST_MNEMOSYNE_DAILY_KEY)


async def acquire_mnemosyne_daily_lock() -> bool:
    redis = get_redis()
    acquired = await redis.set(MNEMOSYNE_DAILY_LOCK_KEY, "1", nx=True, ex=CRON_LOCK_TTL_SECONDS)
    return bool(acquired)


async def release_mnemosyne_daily_lock() -> None:
    redis = get_redis()
    await redis.delete(MNEMOSYNE_DAILY_LOCK_KEY)


async def record_mnemosyne_weekly_heartbeat() -> None:
    await _redis.set(LAST_MNEMOSYNE_WEEKLY_KEY, datetime.now(UTC).isoformat())


async def get_last_mnemosyne_weekly_heartbeat() -> str | None:
    return await _redis.get(LAST_MNEMOSYNE_WEEKLY_KEY)


async def acquire_mnemosyne_weekly_lock() -> bool:
    redis = get_redis()
    acquired = await redis.set(MNEMOSYNE_WEEKLY_LOCK_KEY, "1", nx=True, ex=CRON_LOCK_TTL_SECONDS)
    return bool(acquired)


async def release_mnemosyne_weekly_lock() -> None:
    redis = get_redis()
    await redis.delete(MNEMOSYNE_WEEKLY_LOCK_KEY)


async def record_scan_heartbeat() -> None:
    await _redis.set(LAST_SCAN_KEY, datetime.now(UTC).isoformat())


async def get_last_scan_heartbeat() -> str | None:
    return await _redis.get(LAST_SCAN_KEY)


async def acquire_scan_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the
    Scanner Service's cycle can never run twice concurrently across
    overlapping deploy instances."""
    redis = get_redis()
    ttl = settings.scanner_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(SCAN_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_scan_lock() -> None:
    """Only ever call after acquire_scan_lock() returned True — see
    release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(SCAN_LOCK_KEY)


async def record_signal_scoring_heartbeat() -> None:
    await _redis.set(LAST_SIGNAL_SCORING_KEY, datetime.now(UTC).isoformat())


async def get_last_signal_scoring_heartbeat() -> str | None:
    return await _redis.get(LAST_SIGNAL_SCORING_KEY)


async def acquire_signal_scoring_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the
    Signal Engine's cycle can never run twice concurrently across
    overlapping deploy instances (and, since signal_scores.candidate_setup_id
    is unique, never double-score the same candidate under a deploy
    overlap either)."""
    redis = get_redis()
    ttl = settings.signal_engine_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(SIGNAL_SCORING_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_signal_scoring_lock() -> None:
    """Only ever call after acquire_signal_scoring_lock() returned True —
    see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(SIGNAL_SCORING_LOCK_KEY)


async def record_decision_gate_heartbeat() -> None:
    await _redis.set(LAST_DECISION_GATE_KEY, datetime.now(UTC).isoformat())


async def get_last_decision_gate_heartbeat() -> str | None:
    return await _redis.get(LAST_DECISION_GATE_KEY)


async def acquire_decision_gate_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the
    Decision Gate's cycle can never run twice concurrently across
    overlapping deploy instances (double-routing is guarded further by
    decision_gate_log's own idempotency check, but this is the cheaper,
    first line of defense, same as every other job in this service)."""
    redis = get_redis()
    ttl = settings.decision_gate_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(DECISION_GATE_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_decision_gate_lock() -> None:
    """Only ever call after acquire_decision_gate_lock() returned True —
    see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(DECISION_GATE_LOCK_KEY)


async def record_value_ledger_rollup_heartbeat() -> None:
    await _redis.set(LAST_VALUE_LEDGER_ROLLUP_KEY, datetime.now(UTC).isoformat())


async def get_last_value_ledger_rollup_heartbeat() -> str | None:
    return await _redis.get(LAST_VALUE_LEDGER_ROLLUP_KEY)


async def acquire_value_ledger_rollup_lock() -> bool:
    redis = get_redis()
    acquired = await redis.set(VALUE_LEDGER_ROLLUP_LOCK_KEY, "1", nx=True, ex=CRON_LOCK_TTL_SECONDS)
    return bool(acquired)


async def release_value_ledger_rollup_lock() -> None:
    redis = get_redis()
    await redis.delete(VALUE_LEDGER_ROLLUP_LOCK_KEY)


async def record_payout_detection_heartbeat() -> None:
    await _redis.set(LAST_PAYOUT_DETECTION_KEY, datetime.now(UTC).isoformat())


async def get_last_payout_detection_heartbeat() -> str | None:
    return await _redis.get(LAST_PAYOUT_DETECTION_KEY)


async def acquire_payout_detection_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so
    withdrawal detection (app/payout_detection.py) can never run twice
    concurrently across overlapping deploy instances. Double-detection
    would mean double-counting a single withdrawal against the same prior
    snapshot, not just a wasted cycle."""
    redis = get_redis()
    ttl = settings.payout_detection_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(PAYOUT_DETECTION_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_payout_detection_lock() -> None:
    """Only ever call after acquire_payout_detection_lock() returned True
    — see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(PAYOUT_DETECTION_LOCK_KEY)


async def record_portfolio_risk_heartbeat() -> None:
    await _redis.set(LAST_PORTFOLIO_RISK_KEY, datetime.now(UTC).isoformat())


async def get_last_portfolio_risk_heartbeat() -> str | None:
    return await _redis.get(LAST_PORTFOLIO_RISK_KEY)


async def acquire_portfolio_risk_lock() -> bool:
    """Same reasoning as acquire_poll_lock — a distinct lock key so the
    Portfolio Risk Aggregator's cycle can never run twice concurrently
    across overlapping deploy instances."""
    redis = get_redis()
    ttl = settings.portfolio_risk_interval_seconds + POLL_LOCK_TTL_BUFFER_SECONDS
    acquired = await redis.set(PORTFOLIO_RISK_LOCK_KEY, "1", nx=True, ex=ttl)
    return bool(acquired)


async def release_portfolio_risk_lock() -> None:
    """Only ever call after acquire_portfolio_risk_lock() returned True —
    see release_poll_lock's docstring for why."""
    redis = get_redis()
    await redis.delete(PORTFOLIO_RISK_LOCK_KEY)


async def cache_fx_rate(currency: str, rate_to_usd: str, source: str, fetched_at: str) -> None:
    """Written by fx_service.py's refresh job; read by both this service's
    own Python code and the Next.js app's src/lib/fx.ts (same shared
    Upstash instance) via key fx:{currency}. TTL 3600s — half that is the
    refresh job's own interval, so one failed run never causes a miss."""
    await _redis.set(
        f"fx:{currency}",
        json.dumps({"rate": rate_to_usd, "fetchedAt": fetched_at, "source": source}),
        ex=3600,
    )
