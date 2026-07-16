from .config import settings
from .redis_cache import get_redis


async def check_and_set_rate_limit(user_id: str) -> bool:
    """Returns True if this call may proceed (and claims the window),
    False if a manual sync was already triggered for this user within
    the last `sync_rate_limit_seconds`. NX+EX makes the claim atomic —
    two concurrent requests can't both pass."""
    redis = get_redis()
    key = f"ratelimit:sync:{user_id}"
    was_set = await redis.set(key, "1", nx=True, ex=settings.sync_rate_limit_seconds)
    return bool(was_set)
