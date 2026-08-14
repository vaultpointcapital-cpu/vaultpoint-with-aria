import re
from enum import Enum

import httpx

from .brokers.metatrader import MetaTraderAccountNotReadyError, MetaTraderAuthError
from .models import BrokerType


class SyncOutcome(str, Enum):
    """What a single sync_connection() attempt actually resulted in —
    the input to the health transition table in sync_service.py, and to
    the backoff calculation. TRANSIENT is the safe default: an outcome
    this service can't confidently classify degrades to TRANSIENT
    (retried with backoff) rather than incorrectly treating an ordinary
    network blip as AUTH_FAILED and halting polling on a connection
    that's actually fine.
    """

    SUCCESS = "success"
    TRANSIENT = "transient"
    RATE_LIMITED = "rate_limited"
    AUTH_FAILED = "auth_failed"
    ACCOUNT_CLOSED = "account_closed"


# Bybit v5 auth-related retCodes — from Bybit's own "Error Codes"
# documentation. Flagged as best-effort: this service has no live
# failure catalog to validate every code against, so classification here
# is informed by documented codes, not observed failures. A code not
# listed here falls through to TRANSIENT, which just means "retried with
# backoff" — the safe direction to be wrong in.
#   10003 - API key is invalid
#   10004 - error sign / signature verification failed
#   33004 - apikey has expired
_BYBIT_AUTH_RET_CODES = {"10003", "10004", "33004"}
_BYBIT_RET_CODE_RE = re.compile(r"Bybit API error (\d+):")

# KuCoin auth-related error codes — from KuCoin Futures' documented
# error code list. Same best-effort caveat as Bybit above.
#   400003 - KC-API-KEY not exists
#   400004 - KC-API-PASSPHRASE error
#   400005 - Signature error
#   400006 - The requested ip address is not in the api whitelist
_KUCOIN_AUTH_CODES = {"400003", "400004", "400005", "400006"}
_KUCOIN_CODE_RE = re.compile(r"KuCoin API error (\d+):")


def _classify_bybit(exc: Exception) -> SyncOutcome:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return SyncOutcome.AUTH_FAILED
        if status == 429:
            return SyncOutcome.RATE_LIMITED
        return SyncOutcome.TRANSIENT

    if isinstance(exc, RuntimeError):
        match = _BYBIT_RET_CODE_RE.search(str(exc))
        if match and match.group(1) in _BYBIT_AUTH_RET_CODES:
            return SyncOutcome.AUTH_FAILED

    return SyncOutcome.TRANSIENT


def _classify_binance(exc: Exception) -> SyncOutcome:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return SyncOutcome.AUTH_FAILED
        if status in (418, 429):
            return SyncOutcome.RATE_LIMITED
        return SyncOutcome.TRANSIENT

    return SyncOutcome.TRANSIENT


def _classify_kucoin(exc: Exception) -> SyncOutcome:
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return SyncOutcome.AUTH_FAILED
        if status == 429:
            return SyncOutcome.RATE_LIMITED
        return SyncOutcome.TRANSIENT

    if isinstance(exc, RuntimeError):
        match = _KUCOIN_CODE_RE.search(str(exc))
        if match and match.group(1) in _KUCOIN_AUTH_CODES:
            return SyncOutcome.AUTH_FAILED

    return SyncOutcome.TRANSIENT


def _classify_metatrader(exc: Exception) -> SyncOutcome:
    # Not-deployed-yet is expected to self-resolve on a later poll (the
    # terminal is still spinning up) — never an auth problem.
    if isinstance(exc, MetaTraderAccountNotReadyError):
        return SyncOutcome.TRANSIENT

    if isinstance(exc, MetaTraderAuthError):
        return SyncOutcome.AUTH_FAILED

    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (401, 403):
            return SyncOutcome.AUTH_FAILED
        if status == 429:
            return SyncOutcome.RATE_LIMITED
        return SyncOutcome.TRANSIENT

    return SyncOutcome.TRANSIENT


_CLASSIFIERS = {
    BrokerType.BYBIT: _classify_bybit,
    BrokerType.BINANCE: _classify_binance,
    BrokerType.KUCOIN: _classify_kucoin,
    BrokerType.METATRADER: _classify_metatrader,
}


def classify_error(broker: BrokerType, exc: Exception) -> SyncOutcome:
    """Dispatches to the per-broker classifier. Anything not confidently
    identified as auth/rate-limit falls through to TRANSIENT — see the
    SyncOutcome docstring for why that's the deliberate safe default.
    """
    classifier = _CLASSIFIERS.get(broker)
    if classifier is None:
        return SyncOutcome.TRANSIENT
    return classifier(exc)
