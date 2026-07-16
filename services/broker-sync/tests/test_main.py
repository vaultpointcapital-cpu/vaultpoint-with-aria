from datetime import datetime, timedelta, timezone

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
    return datetime.now(timezone.utc).isoformat()


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
        return (datetime.now(timezone.utc) - timedelta(seconds=age)).isoformat()

    monkeypatch.setattr(main, "get_service_client", _healthy_supabase)
    monkeypatch.setattr(main, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(main, "get_last_poll_heartbeat", stale)

    response = client.get("/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["last_successful_poll_stale"] is True
