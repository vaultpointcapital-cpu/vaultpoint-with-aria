import pytest

from app.signal_engine import service
from app.signal_engine.scorer import ScoringResult, ScoringSkipped
from tests.conftest import FakeSupabase

_RESULT = ScoringResult(
    confidence_score=88,
    action_class="AUTO_ELIGIBLE",
    reasoning="Clean setup.",
    key_risk_factors=["Tight stop."],
    input_tokens=100,
    output_tokens=50,
    latency_ms=1200,
)


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(service, "get_service_client", lambda: fake)
    monkeypatch.setattr(service.settings, "anthropic_api_key", "test-key")
    return fake


async def test_scores_each_pending_candidate_once(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("candidate_setups", "*")] = [
        {"id": "c1", "symbol": "XAUUSD", "structure_type": "liquidity_sweep"},
        {"id": "c2", "symbol": "EURUSD", "structure_type": "bos"},
    ]

    async def fake_score_candidate(candidate, macro_context):
        return _RESULT

    monkeypatch.setattr(service, "score_candidate", fake_score_candidate)

    await service.score_pending_candidates()

    inserts = fake_supabase.calls_for("signal_scores", "insert")
    assert len(inserts) == 2
    assert {c.values["candidate_setup_id"] for c in inserts} == {"c1", "c2"}
    assert inserts[0].values["action_class"] == "AUTO_ELIGIBLE"
    assert inserts[0].values["confidence_score"] == 88

    updates = fake_supabase.calls_for("candidate_setups", "update")
    assert len(updates) == 2
    assert all(u.values == {"status": "scored"} for u in updates)


async def test_skips_cycle_when_no_api_key(fake_supabase, monkeypatch):
    monkeypatch.setattr(service.settings, "anthropic_api_key", None)
    fake_supabase.select_responses[("candidate_setups", "*")] = [{"id": "c1"}]

    await service.score_pending_candidates()

    assert fake_supabase.calls_for("candidate_setups", "select") == []


async def test_no_pending_candidates_is_a_noop(fake_supabase):
    fake_supabase.select_responses[("candidate_setups", "*")] = []

    await service.score_pending_candidates()

    assert fake_supabase.calls_for("signal_scores", "insert") == []


async def test_one_failing_candidate_does_not_block_the_rest(fake_supabase, monkeypatch):
    fake_supabase.select_responses[("candidate_setups", "*")] = [
        {"id": "c1"},
        {"id": "c2"},
    ]

    async def fake_score_candidate(candidate, macro_context):
        if candidate["id"] == "c1":
            raise ScoringSkipped("rate limited")
        return _RESULT

    monkeypatch.setattr(service, "score_candidate", fake_score_candidate)

    await service.score_pending_candidates()

    inserts = fake_supabase.calls_for("signal_scores", "insert")
    assert len(inserts) == 1
    assert inserts[0].values["candidate_setup_id"] == "c2"

    updates = fake_supabase.calls_for("candidate_setups", "update")
    assert len(updates) == 1
