import httpx
import pytest

from app.brokers.metatrader import MetaTraderAccountNotReadyError, MetaTraderAuthError
from app.models import BrokerType
from app.sync_outcomes import SyncOutcome, classify_error


def _http_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://example.com")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


class TestBybit:
    @pytest.mark.parametrize("code", ["10003", "10004", "33004"])
    def test_known_auth_ret_codes_classify_as_auth_failed(self, code):
        exc = RuntimeError(f"Bybit API error {code}: some message")
        assert classify_error(BrokerType.BYBIT, exc) is SyncOutcome.AUTH_FAILED

    def test_unknown_ret_code_falls_through_to_transient(self):
        exc = RuntimeError("Bybit API error 10001: parameter error")
        assert classify_error(BrokerType.BYBIT, exc) is SyncOutcome.TRANSIENT

    def test_rate_limit_ret_message_is_transient_not_rate_limited(self):
        # Bybit's own client already retries a 429 in-request (MAX_RETRIES)
        # — by the time this bubbles up as an exception, retries were
        # already exhausted, so this is the module-level RuntimeError
        # shape, not an HTTPStatusError with status 429.
        exc = RuntimeError("Bybit API rate limit exceeded after retries.")
        assert classify_error(BrokerType.BYBIT, exc) is SyncOutcome.TRANSIENT

    def test_http_401_classifies_as_auth_failed(self):
        assert classify_error(BrokerType.BYBIT, _http_error(401)) is SyncOutcome.AUTH_FAILED

    def test_http_429_classifies_as_rate_limited(self):
        assert classify_error(BrokerType.BYBIT, _http_error(429)) is SyncOutcome.RATE_LIMITED

    def test_http_500_classifies_as_transient(self):
        assert classify_error(BrokerType.BYBIT, _http_error(500)) is SyncOutcome.TRANSIENT


class TestBinance:
    @pytest.mark.parametrize("status", [401, 403])
    def test_401_403_classify_as_auth_failed(self, status):
        assert classify_error(BrokerType.BINANCE, _http_error(status)) is SyncOutcome.AUTH_FAILED

    @pytest.mark.parametrize("status", [418, 429])
    def test_418_429_classify_as_rate_limited(self, status):
        assert classify_error(BrokerType.BINANCE, _http_error(status)) is SyncOutcome.RATE_LIMITED

    def test_other_status_is_transient(self):
        assert classify_error(BrokerType.BINANCE, _http_error(500)) is SyncOutcome.TRANSIENT

    def test_non_http_exception_is_transient(self):
        assert classify_error(BrokerType.BINANCE, RuntimeError("connection reset")) is SyncOutcome.TRANSIENT


class TestKucoin:
    @pytest.mark.parametrize("code", ["400003", "400004", "400005", "400006"])
    def test_known_auth_codes_classify_as_auth_failed(self, code):
        exc = RuntimeError(f"KuCoin API error {code}: bad credentials")
        assert classify_error(BrokerType.KUCOIN, exc) is SyncOutcome.AUTH_FAILED

    def test_unknown_code_falls_through_to_transient(self):
        exc = RuntimeError("KuCoin API error 200001: unknown")
        assert classify_error(BrokerType.KUCOIN, exc) is SyncOutcome.TRANSIENT

    @pytest.mark.parametrize("status", [401, 403])
    def test_http_401_403_classify_as_auth_failed(self, status):
        assert classify_error(BrokerType.KUCOIN, _http_error(status)) is SyncOutcome.AUTH_FAILED

    def test_http_429_classifies_as_rate_limited(self):
        assert classify_error(BrokerType.KUCOIN, _http_error(429)) is SyncOutcome.RATE_LIMITED


class TestMetaTrader:
    def test_account_not_ready_is_transient_not_auth_failed(self):
        """Not-deployed-yet is expected to self-resolve on a later poll —
        never an auth problem, even though it sounds terminal."""
        exc = MetaTraderAccountNotReadyError("still deploying")
        assert classify_error(BrokerType.METATRADER, exc) is SyncOutcome.TRANSIENT

    def test_auth_error_classifies_as_auth_failed(self):
        exc = MetaTraderAuthError("broker rejected the login")
        assert classify_error(BrokerType.METATRADER, exc) is SyncOutcome.AUTH_FAILED

    @pytest.mark.parametrize("status", [401, 403])
    def test_http_401_403_classify_as_auth_failed(self, status):
        assert classify_error(BrokerType.METATRADER, _http_error(status)) is SyncOutcome.AUTH_FAILED

    def test_http_429_classifies_as_rate_limited(self):
        assert classify_error(BrokerType.METATRADER, _http_error(429)) is SyncOutcome.RATE_LIMITED

    def test_generic_runtime_error_is_transient(self):
        exc = RuntimeError("MetaApi positions request failed (500): server error")
        assert classify_error(BrokerType.METATRADER, exc) is SyncOutcome.TRANSIENT


def test_unregistered_broker_falls_through_to_transient():
    """classify_error's dispatcher itself degrades safely for a broker
    with no registered classifier, rather than raising — matches the
    module's own "safe default" philosophy."""

    class _FakeBroker:
        value = "unregistered"

    assert classify_error(_FakeBroker(), RuntimeError("whatever")) is SyncOutcome.TRANSIENT
