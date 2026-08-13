from app.pantheon import plutus
from tests.conftest import FakeSupabase


def position_row(**overrides):
    base = {
        "symbol": "ETHUSDT",
        "side": "long",
        "unrealized_pnl_pct": 35,
        "entry_price": 2000,
        "mark_price": 2700,
    }
    base.update(overrides)
    return base


def connection(**overrides):
    base = {"id": "conn-1", "user_id": "user-1"}
    base.update(overrides)
    return base


async def test_writes_a_caution_finding_at_the_30_pct_bucket():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, plutus_last_severity")] = [
        {"id": "pos-1", "symbol": "ETHUSDT", "side": "long", "plutus_last_severity": "none"}
    ]

    await plutus.evaluate_plutus(fake, connection(), [position_row(unrealized_pnl_pct=35)])

    updates = fake.calls_for("positions", "update")
    assert updates[0].values == {"plutus_last_severity": "caution"}

    inserts = fake.calls_for("aria_findings", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["severity"] == "caution"
    assert inserts[0].values["dedup_key"] == "plutus:profit_alert:ETHUSDT:caution"
    assert inserts[0].values["raw_data"]["suggest_take_pct_range"] == [50, 70]


async def test_writes_an_info_finding_at_the_15_pct_bucket():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, plutus_last_severity")] = [
        {"id": "pos-1", "symbol": "ETHUSDT", "side": "long", "plutus_last_severity": "none"}
    ]

    await plutus.evaluate_plutus(fake, connection(), [position_row(unrealized_pnl_pct=20)])

    inserts = fake.calls_for("aria_findings", "insert")
    assert inserts[0].values["severity"] == "info"
    assert inserts[0].values["raw_data"]["suggest_take_pct_range"] == [30, 50]


async def test_writes_a_caution_finding_at_the_50_pct_bucket():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, plutus_last_severity")] = [
        {"id": "pos-1", "symbol": "ETHUSDT", "side": "long", "plutus_last_severity": "none"}
    ]

    await plutus.evaluate_plutus(fake, connection(), [position_row(unrealized_pnl_pct=60)])

    inserts = fake.calls_for("aria_findings", "insert")
    assert inserts[0].values["raw_data"]["suggest_take_pct_range"] == [70, 100]


async def test_no_write_when_bucket_is_unchanged():
    fake = FakeSupabase()
    fake.select_responses[("positions", "id, symbol, side, plutus_last_severity")] = [
        {"id": "pos-1", "symbol": "ETHUSDT", "side": "long", "plutus_last_severity": "caution"}
    ]

    await plutus.evaluate_plutus(fake, connection(), [position_row(unrealized_pnl_pct=35)])

    assert fake.calls_for("positions", "update") == []
    assert fake.calls_for("aria_findings", "insert") == []


def test_never_emits_warning_or_critical_severity():
    # Plutus's severities are always info/caution (never urgent enough
    # for proactive outreach) — asserted directly against the threshold
    # table rather than every possible pnl value.
    for _, severity, _ in plutus._PROFIT_THRESHOLDS:
        assert severity in ("info", "caution")
