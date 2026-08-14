import anthropic
import httpx
import pytest

from app.signal_engine import scorer


class _ToolUseBlock:
    def __init__(self, input_data):
        self.type = "tool_use"
        self.input = input_data


class _Usage:
    def __init__(self, input_tokens=111, output_tokens=42):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResponse:
    def __init__(self, tool_input=None, usage=None):
        self.content = [_ToolUseBlock(tool_input)] if tool_input is not None else []
        self.usage = usage or _Usage()


class _FakeMessages:
    def __init__(self, response=None, exception=None):
        self.response = response
        self.exception = exception
        self.captured_calls: list[dict] = []

    async def create(self, **kwargs):
        self.captured_calls.append(kwargs)
        if self.exception:
            raise self.exception
        return self.response


class _FakeAsyncAnthropic:
    """Stand-in for anthropic.AsyncAnthropic. Reads its behavior from
    class-level `response`/`exception`, set per-test before calling
    score_candidate() — same class-level-config-then-reset shape
    test_pantheon_hermes.py's _FakeAsyncClient uses for httpx."""

    response: object = None
    exception: Exception | None = None
    last_messages: _FakeMessages | None = None

    def __init__(self, api_key=None):
        self.api_key = api_key
        self.messages = _FakeMessages(response=_FakeAsyncAnthropic.response, exception=_FakeAsyncAnthropic.exception)
        _FakeAsyncAnthropic.last_messages = self.messages

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def _http_response(status_code: int) -> httpx.Response:
    return httpx.Response(status_code, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))


def _http_request() -> httpx.Request:
    return httpx.Request("POST", "https://api.anthropic.com/v1/messages")


@pytest.fixture(autouse=True)
def reset_fake_anthropic():
    _FakeAsyncAnthropic.response = None
    _FakeAsyncAnthropic.exception = None
    _FakeAsyncAnthropic.last_messages = None


@pytest.fixture
def fake_anthropic(monkeypatch):
    monkeypatch.setattr(scorer.settings, "anthropic_api_key", "test-key")
    monkeypatch.setattr(scorer.anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)
    return _FakeAsyncAnthropic


VALID_TOOL_INPUT = {
    "confidence_score": 82,
    "action_class": "AUTO_ELIGIBLE",
    "reasoning": "Clean liquidity sweep with confluence from the higher timeframe order block.",
    "key_risk_factors": ["Stop is tight relative to recent ATR."],
}


async def test_score_candidate_parses_forced_tool_response(fake_anthropic):
    fake_anthropic.response = _FakeResponse(VALID_TOOL_INPUT)

    result = await scorer.score_candidate({"symbol": "XAUUSD"}, {})

    assert result.confidence_score == 82
    assert result.action_class == "AUTO_ELIGIBLE"
    assert result.reasoning == VALID_TOOL_INPUT["reasoning"]
    assert result.key_risk_factors == VALID_TOOL_INPUT["key_risk_factors"]
    assert result.input_tokens == 111
    assert result.output_tokens == 42

    call = fake_anthropic.last_messages.captured_calls[0]
    assert call["tool_choice"] == {"type": "tool", "name": "submit_signal_score"}
    assert call["tools"][0]["name"] == "submit_signal_score"
    assert call["model"] == scorer.settings.signal_engine_model


async def test_score_candidate_raises_scoring_skipped_when_no_api_key(monkeypatch):
    monkeypatch.setattr(scorer.settings, "anthropic_api_key", None)

    with pytest.raises(scorer.ScoringSkipped):
        await scorer.score_candidate({"symbol": "XAUUSD"}, {})


async def test_rate_limit_error_becomes_scoring_skipped(fake_anthropic):
    fake_anthropic.exception = anthropic.RateLimitError("rate limited", response=_http_response(429), body=None)

    with pytest.raises(scorer.ScoringSkipped):
        await scorer.score_candidate({"symbol": "XAUUSD"}, {})


async def test_connection_error_becomes_scoring_skipped(fake_anthropic):
    fake_anthropic.exception = anthropic.APIConnectionError(request=_http_request())

    with pytest.raises(scorer.ScoringSkipped):
        await scorer.score_candidate({"symbol": "XAUUSD"}, {})


async def test_api_status_error_becomes_scoring_skipped(fake_anthropic):
    fake_anthropic.exception = anthropic.APIStatusError("bad request", response=_http_response(400), body=None)

    with pytest.raises(scorer.ScoringSkipped):
        await scorer.score_candidate({"symbol": "XAUUSD"}, {})


async def test_missing_tool_use_block_becomes_scoring_skipped(fake_anthropic):
    fake_anthropic.response = _FakeResponse(tool_input=None)

    with pytest.raises(scorer.ScoringSkipped):
        await scorer.score_candidate({"symbol": "XAUUSD"}, {})
