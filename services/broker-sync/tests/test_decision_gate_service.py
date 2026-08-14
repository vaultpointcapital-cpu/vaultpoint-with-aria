import pytest

from app.decision_gate import service
from app.decision_gate.execution_adapter import ExecutionResult
from tests.conftest import FakeSupabase

BROKER_CONNECTION = {
    "id": "conn-1",
    "user_id": "user-1",
    "broker": "metatrader",
    "health": "healthy",
    "aria_auto_execution_enabled": False,
    "hedging_mode_verified_at": None,
    "aria_auto_execution_cooldown_until": None,
}

AUTO_CONNECTION = {
    **BROKER_CONNECTION,
    "id": "conn-auto",
    "aria_auto_execution_enabled": True,
    "hedging_mode_verified_at": "2026-08-01T00:00:00+00:00",
}

SCORE_ALERT_ONLY = {
    "id": "score-1",
    "candidate_setup_id": "cand-1",
    "confidence_score": 80,
    "action_class": "ALERT_ONLY",
    "reasoning": "clean setup",
}

SCORE_AUTO_ELIGIBLE = {
    "id": "score-2",
    "candidate_setup_id": "cand-1",
    "confidence_score": 90,
    "action_class": "AUTO_ELIGIBLE",
    "reasoning": "very clean setup",
}

CANDIDATE = {
    "id": "cand-1",
    "symbol": "XAUUSD",
    "timeframe": "M5",
    "structure_type": "liquidity_sweep",
    "direction": "long",
    "entry_zone_low": 100,
    "entry_zone_high": 102,
    "stop_loss": 95,
    "take_profit": 110,
}


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(service, "get_service_client", lambda: fake)
    return fake


def _seed(
    fake,
    *,
    scores=None,
    candidates=None,
    connections=None,
    sub_accounts=None,
    sub_connections=None,
    existing_log=None,
):
    fake.select_responses[("signal_scores", "*")] = scores if scores is not None else [SCORE_ALERT_ONLY]
    fake.select_responses[("candidate_setups", "*")] = candidates if candidates is not None else [CANDIDATE]
    fake.select_responses[("broker_connections", "*")] = connections if connections is not None else [BROKER_CONNECTION]
    fake.select_responses[("managed_sub_accounts", "*")] = sub_accounts or []
    fake.select_responses[("broker_connections", "id, broker, health")] = sub_connections or []
    fake.select_responses[("decision_gate_log", "id")] = existing_log or []


@pytest.fixture
def stub_manual_alert(monkeypatch):
    calls = []

    async def fake_send_manual_alert(**kwargs):
        calls.append(kwargs)
        return {"approvalRowId": "approval-row-1"}

    monkeypatch.setattr(service.step_up_client, "send_manual_alert", fake_send_manual_alert)
    return calls


@pytest.fixture
def stub_upsert_finding(monkeypatch):
    calls = []

    async def fake_upsert_finding(supabase, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(service, "upsert_finding", fake_upsert_finding)
    return calls


class TestManualPath:
    async def test_alert_sent_and_finding_written(self, fake_supabase, stub_manual_alert, stub_upsert_finding):
        _seed(fake_supabase)

        await service.evaluate_decision_gate()

        assert len(stub_manual_alert) == 1
        assert stub_manual_alert[0]["user_id"] == "user-1"

        assert len(stub_upsert_finding) == 1
        assert stub_upsert_finding[0]["source_agent"] == "aria_scanner"
        assert stub_upsert_finding[0]["finding_type"] == "trade_setup_alert"
        assert stub_upsert_finding[0]["severity"] == "caution"

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert len(logs) == 1
        assert logs[0].values["decision"] == "alert_sent"
        assert logs[0].values["account_mode"] == "manual"
        assert logs[0].values["step_up_approval_id"] == "approval-row-1"

    async def test_auto_eligible_score_still_manual_when_account_not_opted_in(
        self, fake_supabase, stub_manual_alert, stub_upsert_finding
    ):
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE])

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "alert_sent"

    async def test_alert_failure_is_not_logged_and_will_retry(self, fake_supabase, stub_upsert_finding, monkeypatch):
        _seed(fake_supabase)

        async def failing_send_manual_alert(**kwargs):
            raise service.step_up_client.StepUpAlertError("could not reach the API")

        monkeypatch.setattr(service.step_up_client, "send_manual_alert", failing_send_manual_alert)

        await service.evaluate_decision_gate()

        assert fake_supabase.calls_for("decision_gate_log", "insert") == []
        assert stub_upsert_finding == []

    async def test_portfolio_risk_gate_checks_never_run_on_the_manual_path(
        self, fake_supabase, stub_manual_alert, stub_upsert_finding, monkeypatch
    ):
        # Manual is alert-only, no capital moves — Portfolio Risk
        # Aggregator's checks exist to gate NEW auto-trades, so they must
        # never even be consulted here, same posture as hedging/cooldown/
        # confidence/sizing (all auto-path-only already).
        circuit_breaker_calls = []
        concentration_calls = []

        async def spy_circuit_breaker(*args, **kwargs):
            circuit_breaker_calls.append((args, kwargs))
            return False

        async def spy_concentration(*args, **kwargs):
            concentration_calls.append((args, kwargs))
            return False

        monkeypatch.setattr(service.gate_check, "is_circuit_breaker_tripped", spy_circuit_breaker)
        monkeypatch.setattr(service.gate_check, "is_concentration_capped", spy_concentration)
        _seed(fake_supabase)

        await service.evaluate_decision_gate()

        assert circuit_breaker_calls == []
        assert concentration_calls == []


class TestAutoPath:
    async def test_rejected_when_hedging_not_verified(self, fake_supabase, monkeypatch):
        connection = {**AUTO_CONNECTION, "hedging_mode_verified_at": None}
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE], connections=[connection])
        submit_calls = []
        monkeypatch.setattr(service, "get_execution_adapter", lambda: _FakeAdapter(submit_calls))

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_hedging_not_verified"
        assert submit_calls == []

    async def test_rejected_when_in_cooldown(self, fake_supabase, monkeypatch):
        connection = {**AUTO_CONNECTION, "aria_auto_execution_cooldown_until": "2099-01-01T00:00:00+00:00"}
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE], connections=[connection])

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_cooldown"
        assert logs[0].values["cooldown_active"] is True

    async def test_rejected_when_confidence_below_threshold(self, fake_supabase, monkeypatch):
        monkeypatch.setattr(service.settings, "decision_gate_confidence_threshold", 75.0)
        low_confidence_score = {**SCORE_AUTO_ELIGIBLE, "confidence_score": 50}
        _seed(fake_supabase, scores=[low_confidence_score], connections=[AUTO_CONNECTION])

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_confidence"

    async def test_rejected_when_stop_distance_is_zero(self, fake_supabase):
        malformed_candidate = {**CANDIDATE, "entry_zone_low": 95, "entry_zone_high": 95, "stop_loss": 95}
        _seed(
            fake_supabase,
            scores=[SCORE_AUTO_ELIGIBLE],
            candidates=[malformed_candidate],
            connections=[AUTO_CONNECTION],
        )

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_sizing"

    async def test_rejected_when_circuit_breaker_tripped(self, fake_supabase, monkeypatch):
        # AUTO_CONNECTION has no "book" key -> scope.resolve_book treats
        # it as self_directed, scoped by user_id — see gate_check.py.
        fake_supabase.select_responses[("book_risk_state", "tripped")] = [{"tripped": True}]
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE], connections=[AUTO_CONNECTION])
        submit_calls = []
        monkeypatch.setattr(service, "get_execution_adapter", lambda: _FakeAdapter(submit_calls))

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_circuit_breaker"
        assert submit_calls == []

    async def test_rejected_when_concentration_capped(self, fake_supabase, monkeypatch):
        monkeypatch.setattr(service.settings, "decision_gate_confidence_threshold", 75.0)
        # CANDIDATE's symbol is XAUUSD -> currency legs are just XAU (USD
        # is never itself a "concentration"). net_notional_usd here is
        # well past the default 25% cap against a 10,000 baseline_equity.
        fake_supabase.select_responses[("book_exposure_state", "currency_or_asset, net_notional_usd")] = [
            {"currency_or_asset": "XAU", "net_notional_usd": 5000}
        ]
        fake_supabase.select_responses[("book_risk_state", "baseline_equity")] = [{"baseline_equity": 10000}]
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE], connections=[AUTO_CONNECTION])
        submit_calls = []
        monkeypatch.setattr(service, "get_execution_adapter", lambda: _FakeAdapter(submit_calls))

        await service.evaluate_decision_gate()

        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_rejected_concentration_cap"
        assert submit_calls == []

    async def test_clears_every_gate_and_calls_the_execution_adapter(self, fake_supabase, monkeypatch):
        monkeypatch.setattr(service.settings, "decision_gate_confidence_threshold", 75.0)
        _seed(fake_supabase, scores=[SCORE_AUTO_ELIGIBLE], connections=[AUTO_CONNECTION])
        submit_calls = []
        monkeypatch.setattr(service, "get_execution_adapter", lambda: _FakeAdapter(submit_calls))

        await service.evaluate_decision_gate()

        assert len(submit_calls) == 1
        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["decision"] == "auto_approved_pending_execution_wiring"


class TestIdempotencyAndFanOut:
    async def test_already_routed_pair_is_skipped(self, fake_supabase, stub_manual_alert, stub_upsert_finding):
        _seed(fake_supabase, existing_log=[{"id": "existing-log-row"}])

        await service.evaluate_decision_gate()

        assert stub_manual_alert == []
        assert fake_supabase.calls_for("decision_gate_log", "insert") == []

    async def test_reject_scores_are_excluded_at_query_level(self, fake_supabase):
        _seed(fake_supabase)

        await service.evaluate_decision_gate()

        selects = fake_supabase.calls_for("signal_scores", "select")
        assert len(selects) == 1
        assert ("neq", "action_class", "REJECT") in selects[0].filters

    async def test_fans_out_to_managed_sub_account_using_client_user_id(
        self, fake_supabase, stub_manual_alert, stub_upsert_finding
    ):
        sub_account = {
            "id": "sub-1",
            "client_user_id": "client-user-1",
            "broker_connection_id": "conn-2",
            "status": "active",
            "aria_auto_execution_enabled": False,
            "hedging_mode_verified_at": None,
            "aria_auto_execution_cooldown_until": None,
        }
        sub_connection = {"id": "conn-2", "broker": "metatrader", "health": "healthy"}
        _seed(fake_supabase, connections=[], sub_accounts=[sub_account], sub_connections=[sub_connection])

        await service.evaluate_decision_gate()

        assert len(stub_manual_alert) == 1
        assert stub_manual_alert[0]["user_id"] == "client-user-1"
        logs = fake_supabase.calls_for("decision_gate_log", "insert")
        assert logs[0].values["account_type"] == "managed_sub_account"
        assert logs[0].values["account_id"] == "sub-1"


class _FakeAdapter:
    def __init__(self, calls):
        self._calls = calls

    async def submit(self, account, candidate, score):
        self._calls.append((account, candidate, score))
        return ExecutionResult(status="not_wired")
