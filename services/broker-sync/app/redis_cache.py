import json
from datetime import datetime, timezone
from typing import Optional

from upstash_redis.asyncio import Redis

from .config import settings

_redis = Redis(url=settings.upstash_redis_rest_url, token=settings.upstash_redis_rest_token)

LAST_POLL_KEY = "health:last_successful_poll"


async def cache_positions(connection_id: str, rows: list[dict]) -> None:
    await _redis.set(f"positions:{connection_id}", json.dumps(rows), ex=settings.cache_ttl_seconds)


async def get_cached_positions(connection_id: str) -> Optional[list[dict]]:
    raw = await _redis.get(f"positions:{connection_id}")
    return json.loads(raw) if raw else None


async def record_poll_heartbeat() -> None:
    """Marks that a poll cycle just completed. No TTL — a missing value
    means "never polled," which /health should always be able to tell
    apart from "polled a while ago."
    """
    await _redis.set(LAST_POLL_KEY, datetime.now(timezone.utc).isoformat())


async def get_last_poll_heartbeat() -> Optional[str]:
    return await _redis.get(LAST_POLL_KEY)


def get_redis() -> Redis:
    """Shared client for anything else (e.g. the rate limiter) that needs
    direct Redis access without importing the module-private `_redis`."""
    return _redis
