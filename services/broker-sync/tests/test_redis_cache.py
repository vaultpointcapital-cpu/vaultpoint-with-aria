from app import redis_cache


class FakeRedisClient:
    def __init__(self, set_return=True):
        self.set_return = set_return
        self.set_calls = []
        self.delete_calls = []

    async def set(self, key, value, nx=False, ex=None):
        self.set_calls.append({"key": key, "value": value, "nx": nx, "ex": ex})
        return self.set_return

    async def delete(self, key):
        self.delete_calls.append(key)


async def test_acquire_poll_lock_uses_set_nx_with_ttl_above_interval(monkeypatch):
    fake = FakeRedisClient(set_return=True)
    monkeypatch.setattr(redis_cache, "get_redis", lambda: fake)

    acquired = await redis_cache.acquire_poll_lock()

    assert acquired is True
    assert len(fake.set_calls) == 1
    call = fake.set_calls[0]
    assert call["key"] == redis_cache.POLL_LOCK_KEY
    assert call["nx"] is True
    # TTL must be strictly greater than the poll interval — the whole
    # point is surviving one full cycle, not expiring mid-cycle.
    assert call["ex"] > redis_cache.settings.poll_interval_seconds
    assert call["ex"] == redis_cache.settings.poll_interval_seconds + redis_cache.POLL_LOCK_TTL_BUFFER_SECONDS


async def test_acquire_poll_lock_returns_false_when_already_held(monkeypatch):
    # Upstash's SET NX returns None (falsy) when the key already exists.
    fake = FakeRedisClient(set_return=None)
    monkeypatch.setattr(redis_cache, "get_redis", lambda: fake)

    acquired = await redis_cache.acquire_poll_lock()

    assert acquired is False


async def test_release_poll_lock_deletes_the_lock_key(monkeypatch):
    fake = FakeRedisClient()
    monkeypatch.setattr(redis_cache, "get_redis", lambda: fake)

    await redis_cache.release_poll_lock()

    assert fake.delete_calls == [redis_cache.POLL_LOCK_KEY]
