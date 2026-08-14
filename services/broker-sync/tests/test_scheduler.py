from datetime import UTC, datetime

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


async def test_poll_filters_on_health_and_next_attempt_at(monkeypatch):
    """The highest-risk change in the Connection Health build (per the
    plan): a bug in this query could silently stop polling real
    connections. Asserts the exact filters sent to Supabase — .neq on
    'health'/'closed' (matching broker_connections_poll_idx's partial-
    index predicate so it's actually usable) and .lte on
    'next_attempt_at' (the backoff gate) — rather than just that some
    query ran.
    """
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = []

    async def _lock_acquired():
        return True

    async def _fake_sync_connection(connection):
        pass

    async def _fake_heartbeat():
        pass

    async def _fake_release():
        pass

    monkeypatch.setattr(scheduler, "acquire_poll_lock", _lock_acquired)
    monkeypatch.setattr(scheduler, "get_service_client", lambda: supabase)
    monkeypatch.setattr(scheduler, "sync_connection", _fake_sync_connection)
    monkeypatch.setattr(scheduler, "record_poll_heartbeat", _fake_heartbeat)
    monkeypatch.setattr(scheduler, "release_poll_lock", _fake_release)

    await scheduler.poll_all_connections()

    queries = supabase.calls_for("broker_connections", "select")
    # One query per broker in BROKER_CLIENTS' insertion order.
    assert len(queries) == len(scheduler.BROKER_CLIENTS)
    for query in queries:
        assert ("neq", "health", "closed") in query.filters
        lte_filters = [f for f in query.filters if f[0] == "lte" and f[1] == "next_attempt_at"]
        assert len(lte_filters) == 1
        # The cutoff must be "now" (not e.g. accidentally omitted or a
        # fixed/stale value) — parses as a real, current ISO timestamp.
        cutoff = datetime.fromisoformat(lte_filters[0][2])
        assert abs((datetime.now(UTC) - cutoff).total_seconds()) < 5
        # sync_status is deliberately NOT filtered on anymore — health is
        # authoritative, sync_status is just the derived view.
        assert not any(f[1] == "sync_status" for f in query.filters)


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
