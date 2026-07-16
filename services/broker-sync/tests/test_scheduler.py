import pytest

from app import scheduler
from tests.conftest import FakeSupabase


async def test_poll_skips_entirely_when_lock_not_acquired(monkeypatch):
    """The core guarantee this whole feature exists for: if another
    instance already holds the poll lock (e.g. during a Railway
    zero-downtime deploy overlap), this instance must not touch
    Supabase, must not sync any connection, and must not record a
    heartbeat — a skipped cycle is silent, not a partial one.
    """
    supabase_calls = []
    sync_calls = []
    heartbeat_calls = []
    release_calls = []

    async def _lock_held_elsewhere():
        return False

    def _get_service_client():
        supabase_calls.append(True)
        return FakeSupabase()

    async def _fake_sync_connection(connection):
        sync_calls.append(connection)

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_poll_lock", _lock_held_elsewhere)
    monkeypatch.setattr(scheduler, "get_service_client", _get_service_client)
    monkeypatch.setattr(scheduler, "sync_connection", _fake_sync_connection)
    monkeypatch.setattr(scheduler, "record_poll_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_poll_lock", _fake_release)

    await scheduler.poll_all_connections()

    assert supabase_calls == []
    assert sync_calls == []
    assert heartbeat_calls == []
    # Never acquired, so must never attempt to release someone else's lock.
    assert release_calls == []


async def test_poll_runs_and_records_heartbeat_when_lock_acquired(monkeypatch):
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = [
        {"id": "conn-1", "user_id": "user-1", "broker": "bybit"}
    ]

    sync_calls = []
    heartbeat_calls = []
    release_calls = []

    async def _lock_acquired():
        return True

    async def _fake_sync_connection(connection):
        sync_calls.append(connection)

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_poll_lock", _lock_acquired)
    monkeypatch.setattr(scheduler, "get_service_client", lambda: supabase)
    monkeypatch.setattr(scheduler, "sync_connection", _fake_sync_connection)
    monkeypatch.setattr(scheduler, "record_poll_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_poll_lock", _fake_release)

    await scheduler.poll_all_connections()

    # FakeQuery's select_responses are keyed only by (table, columns), not
    # by the .eq("broker", ...) filter value — so this same fixture row
    # comes back once per broker in BROKER_CLIENTS, not once total. What
    # actually matters here: the poll loop reached Supabase at all, called
    # sync_connection with the row it got back, then recorded a heartbeat
    # and released the lock.
    assert len(sync_calls) == len(scheduler.BROKER_CLIENTS)
    assert all(call["id"] == "conn-1" for call in sync_calls)
    assert heartbeat_calls == [True]
    assert release_calls == [True]


async def test_poll_releases_lock_even_if_sync_raises(monkeypatch):
    """The lock must not be left held if something inside the cycle
    blows up — otherwise a single bad cycle would block every future
    cycle (on any instance) until the TTL safety net expires."""
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = [
        {"id": "conn-1", "user_id": "user-1", "broker": "bybit"}
    ]

    release_calls = []
    heartbeat_calls = []

    async def _lock_acquired():
        return True

    async def _raising_sync_connection(connection):
        raise RuntimeError("boom")

    async def _fake_heartbeat():
        heartbeat_calls.append(True)

    async def _fake_release():
        release_calls.append(True)

    monkeypatch.setattr(scheduler, "acquire_poll_lock", _lock_acquired)
    monkeypatch.setattr(scheduler, "get_service_client", lambda: supabase)
    monkeypatch.setattr(scheduler, "sync_connection", _raising_sync_connection)
    monkeypatch.setattr(scheduler, "record_poll_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_poll_lock", _fake_release)

    with pytest.raises(RuntimeError):
        await scheduler.poll_all_connections()

    assert release_calls == [True]
    # The exception happened before the heartbeat line, so it must not
    # have been recorded — a crashed cycle shouldn't look like a
    # successful one to /health.
    assert heartbeat_calls == []
