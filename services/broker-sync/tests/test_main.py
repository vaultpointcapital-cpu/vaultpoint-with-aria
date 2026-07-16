from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import main
from tests.conftest import FakeSupabase


class FakeRedis:
    def __init__(self, fail: bool = False):
        self.fail = fail

    async def ping(self):
        if self.fail:
            raise ConnectionError("redis unreachable")
        return True


@pytest.fixture
def client():
    # Not used as a context manager on purpose — that would run the real
    # lifespan and start the APScheduler against fake Supabase/Redis.
    return TestClient(main.app)


def _healthy_supabase() -> FakeSupabase:
    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "id")] = []
    return supabase


async def _fresh_heartbeat() -> str:
    return datetime.now(UTC).isoformat()


def test_health_ok_when_all_checks_pass(monkeypatch, client):
    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["redis"] == "ok"
    assert body["checks"]["last_successful_poll"] is not None


def test_health_degraded_when_database_fails(monkeypatch, client):
    def _raise():
        raise Exception("db down")

    monkeypatch.setattr(main, "get_service_client", _raise)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)

    response = client.get("/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["database"].startswith("error")


def test_health_degraded_when_redis_fails(monkeypatch, client):
    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis(fail=True))
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)

    response = client.get("/health")

    assert response.status_code == 503
    assert response.json()["checks"]["redis"].startswith("error")


def test_health_degraded_when_never_polled(monkeypatch, client):
    async def never() -> None:
        return None

    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", never)

    response = client.get("/health")

    assert response.status_code == 503
    assert response.json()["checks"]["last_successful_poll"] is None


def test_health_degraded_when_poll_heartbeat_stale(monkeypatch, client):
    async def stale() -> str:
        age = main.settings.poll_interval_seconds * main.POLL_STALE_MULTIPLIER + 30
        return (datetime.now(UTC) - timedelta(seconds=age)).isoformat()

    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", stale)

    response = client.get("/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["last_successful_poll_stale"] is True


def test_health_degraded_when_heartbeat_read_fails(monkeypatch, client):
    """Regression test: get_last_poll_heartbeat() used to be the one
    Redis-touching call in this endpoint NOT wrapped in try/except, so a
    Redis outage on this specific call (distinct from ping() failing)
    crashed the endpoint into a raw 500 instead of the intended 503
    degraded response — caught by manually exercising this against a
    real unreachable Redis URL, not by any prior test.
    """

    async def _raise():
        raise ConnectionError("redis unreachable during GET")

    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _raise)

    response = client.get("/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["last_successful_poll"].startswith("error")


def test_health_reports_commit_sha_when_set_by_railway(monkeypatch, client):
    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "abc1234")

    response = client.get("/health")

    assert response.json()["version"] == "abc1234"


def test_health_reports_unknown_version_outside_railway(monkeypatch, client):
    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)
    monkeypatch.delenv("RAILWAY_GIT_COMMIT_SHA", raising=False)

    response = client.get("/health")

    assert response.json()["version"] == "unknown"


def test_health_requires_no_api_key(monkeypatch, client):
    """/health must stay open for Railway's uptime checks — no
    x-api-key header sent at all here, unlike every /sync test below."""
    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", _fresh_heartbeat)

    response = client.get("/health")

    assert response.status_code == 200


# ---------------------------------------------------------------------
# POST /sync/{user_id} — auth enforcement
# ---------------------------------------------------------------------


def test_sync_rejects_missing_api_key(client):
    response = client.post("/sync/some-user-id")
    assert response.status_code == 401


def test_sync_rejects_empty_api_key(client):
    response = client.post("/sync/some-user-id", headers={"x-api-key": ""})
    assert response.status_code == 401


def test_sync_rejects_wrong_api_key(client):
    response = client.post("/sync/some-user-id", headers={"x-api-key": "wrong-key"})
    assert response.status_code == 401


def test_sync_accepts_correct_api_key_and_runs(monkeypatch, client):
    """Proves the key check isn't the only thing gating this route — a
    correct key actually reaches the handler and it does real work
    (rate-limit check, connection lookup, sync_connection call), not
    just that auth passes.
    """

    async def _allow_rate_limit(user_id: str) -> bool:
        assert user_id == "some-user-id"
        return True

    synced_connections = []

    async def _fake_sync_connection(connection: dict) -> None:
        synced_connections.append(connection)

    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = [
        {"id": "conn-1", "user_id": "some-user-id", "broker": "bybit"}
    ]

    monkeypatch.setattr(main, "check_and_set_rate_limit", _allow_rate_limit)
    monkeypatch.setattr(main, "get_service_client", lambda: supabase)
    monkeypatch.setattr(main, "sync_connection", _fake_sync_connection)

    response = client.post(
        "/sync/some-user-id",
        headers={"x-api-key": main.settings.python_service_api_key},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "synced", "connections": 1}
    assert len(synced_connections) == 1


def test_sync_returns_429_when_rate_limited(monkeypatch, client):
    async def _deny_rate_limit(user_id: str) -> bool:
        return False

    monkeypatch.setattr(main, "check_and_set_rate_limit", _deny_rate_limit)

    response = client.post(
        "/sync/some-user-id",
        headers={"x-api-key": main.settings.python_service_api_key},
    )

    assert response.status_code == 429


def test_sync_returns_404_when_no_connections(monkeypatch, client):
    async def _allow_rate_limit(user_id: str) -> bool:
        return True

    supabase = FakeSupabase()
    supabase.select_responses[("broker_connections", "*")] = []

    monkeypatch.setattr(main, "check_and_set_rate_limit", _allow_rate_limit)
    monkeypatch.setattr(main, "get_service_client", lambda: supabase)

    response = client.post(
        "/sync/some-user-id",
        headers={"x-api-key": main.settings.python_service_api_key},
    )

    assert response.status_code == 404
