import json
from datetime import UTC, datetime

from upstash_redis.asyncio import Redis

from .config import settings

_redis = Redis(url=settings.upstash_redis_rest_url, token=settings.upstash_redis_rest_token)

LAST_POLL_KEY = "health:last_successful_poll"
POLL_LOCK_KEY = "lock:poll_all_connections"
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
