from datetime import UTC, datetime, timedelta

from app.decision_gate import cooldown
from tests.conftest import FakeSupabase


class TestIsInCooldown:
    def test_no_cooldown_field_is_not_in_cooldown(self):
        assert cooldown.is_in_cooldown({"aria_auto_execution_cooldown_until": None}) is False

    def test_future_cooldown_is_active(self):
        future = (datetime.now(UTC) + timedelta(hours=5)).isoformat()
        assert cooldown.is_in_cooldown({"aria_auto_execution_cooldown_until": future}) is True

    def test_past_cooldown_has_cleared(self):
        past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        assert cooldown.is_in_cooldown({"aria_auto_execution_cooldown_until": past}) is False


async def test_trip_cooldown_updates_broker_connection():
    fake = FakeSupabase()

    await cooldown.trip_cooldown(fake, "broker_connection", "conn-1")

    updates = fake.calls_for("broker_connections", "update")
    assert len(updates) == 1
    assert updates[0].filters == [("eq", "id", "conn-1")]
    cooldown_until = datetime.fromisoformat(updates[0].values["aria_auto_execution_cooldown_until"])
    assert cooldown_until > datetime.now(UTC) + timedelta(hours=23)


async def test_trip_cooldown_updates_managed_sub_account():
    fake = FakeSupabase()

    await cooldown.trip_cooldown(fake, "managed_sub_account", "sub-1")

    updates = fake.calls_for("managed_sub_accounts", "update")
    assert len(updates) == 1
    assert updates[0].filters == [("eq", "id", "sub-1")]
