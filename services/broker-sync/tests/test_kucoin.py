import base64
import hashlib
import hmac

import httpx
import pytest

from app.brokers.kucoin import KucoinClient


def make_client(handler) -> KucoinClient:
    """A KucoinClient wired to a fake transport instead of the real network."""
    client = KucoinClient(api_key="test-key", api_secret="test-secret", api_passphrase="test-passphrase")
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api-futures.kucoin.com"
    )
    return client


def ok_response(data) -> dict:
    return {"code": "200000", "data": data}


def position_row(**overrides) -> dict:
    row = {
        "symbol": "XBTUSDTM",
        "currentQty": 1,
        "avgEntryPrice": 60000.0,
        "markPrice": 61200.0,
        "realLeverage": 10.0,
        "unrealisedPnl": 1200.0,
        "unrealisedPnlPcnt": 0.02,
        "posMargin": 6000.0,
    }
    row.update(overrides)
    return row


def contract_row(symbol: str = "XBTUSDTM", multiplier: float = 1.0) -> dict:
    return {"symbol": symbol, "multiplier": multiplier}


def assert_signed_headers(request: httpx.Request, expect_endpoint: str) -> None:
    timestamp = request.headers["KC-API-TIMESTAMP"]
    expected_sign = base64.b64encode(
        hmac.new(
            b"test-secret", f"{timestamp}GET{expect_endpoint}".encode("utf-8"), hashlib.sha256
        ).digest()
    ).decode("utf-8")
    expected_passphrase = base64.b64encode(
        hmac.new(b"test-secret", b"test-passphrase", hashlib.sha256).digest()
    ).decode("utf-8")

    assert request.headers["KC-API-KEY"] == "test-key"
    assert request.headers["KC-API-SIGN"] == expected_sign
    assert request.headers["KC-API-PASSPHRASE"] == expected_passphrase
    assert request.headers["KC-API-KEY-VERSION"] == "2"


def make_positions_handler(position_rows: list[dict], contract_rows: list[dict]):
    """Routes by path: signed GET /api/v1/positions returns position_rows,
    public GET /api/v1/contracts/active (no signing headers) returns
    contract_rows.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/positions":
            assert_signed_headers(request, "/api/v1/positions")
            return httpx.Response(200, json=ok_response(position_rows))
        if request.url.path == "/api/v1/contracts/active":
            assert "KC-API-SIGN" not in request.headers
            return httpx.Response(200, json=ok_response(contract_rows))
        raise AssertionError(f"unexpected path in test: {request.url.path}")

    return handler


def test_requires_passphrase_at_construction():
    with pytest.raises(ValueError, match="api_passphrase"):
        KucoinClient(api_key="k", api_secret="s", api_passphrase=None)

    with pytest.raises(ValueError, match="api_passphrase"):
        KucoinClient(api_key="k", api_secret="s", api_passphrase="")


def test_sign_matches_kucoin_hmac_scheme():
    client = KucoinClient(api_key="test-key", api_secret="test-secret", api_passphrase="test-passphrase")
    timestamp = "1700000000000"

    expected = base64.b64encode(
        hmac.new(b"test-secret", f"{timestamp}GET/api/v1/positions".encode("utf-8"), hashlib.sha256).digest()
    ).decode("utf-8")

    assert client._sign(timestamp, "GET", "/api/v1/positions") == expected


async def test_get_positions_skips_zero_qty_rows():
    handler = make_positions_handler(
        position_rows=[
            position_row(symbol="ETHUSDTM", currentQty=0),
            position_row(symbol="XBTUSDTM", currentQty=1),
        ],
        contract_rows=[contract_row(symbol="XBTUSDTM", multiplier=1.0)],
    )

    client = make_client(handler)
    positions = await client.get_positions()

    assert len(positions) == 1
    position = positions[0]
    assert position.symbol == "XBTUSDTM"
    assert position.side == "long"
    assert position.size == 1
    assert position.entry_price == 60000
    assert position.mark_price == 61200
    assert position.leverage == 10
    assert position.unrealized_pnl == 1200
    assert position.unrealized_pnl_pct == 2.0
    assert position.margin_used == 6000
    assert position.broker_source == "kucoin"


async def test_get_positions_uses_sign_of_current_qty_for_side():
    handler = make_positions_handler(
        position_rows=[position_row(currentQty=-3)],
        contract_rows=[contract_row(symbol="XBTUSDTM", multiplier=1.0)],
    )

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions[0].side == "short"
    assert positions[0].size == 3


async def test_get_positions_converts_contract_count_using_multiplier():
    handler = make_positions_handler(
        position_rows=[position_row(symbol="XBTUSDTM", currentQty=4)],
        contract_rows=[contract_row(symbol="XBTUSDTM", multiplier=0.001)],
    )

    client = make_client(handler)
    positions = await client.get_positions()

    # 4 contracts * 0.001 BTC/contract = 0.004 BTC, not 4 contracts.
    assert positions[0].size == pytest.approx(0.004)


async def test_get_positions_falls_back_to_raw_count_when_multiplier_missing():
    handler = make_positions_handler(
        position_rows=[position_row(symbol="NEWUSDTM", currentQty=2)],
        # NEWUSDTM isn't in the active-contracts list.
        contract_rows=[contract_row(symbol="XBTUSDTM", multiplier=0.001)],
    )

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions[0].size == 2


async def test_get_positions_skips_fetching_multipliers_when_nothing_open():
    calls = {"contracts_active": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/positions":
            return httpx.Response(200, json=ok_response([position_row(currentQty=0)]))
        if request.url.path == "/api/v1/contracts/active":
            calls["contracts_active"] += 1
            return httpx.Response(200, json=ok_response([]))
        raise AssertionError(f"unexpected path in test: {request.url.path}")

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions == []
    assert calls["contracts_active"] == 0


async def test_get_balance_returns_account_equity():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/account-overview"
        assert request.url.query.decode().startswith("currency=USDT")
        assert_signed_headers(request, "/api/v1/account-overview?currency=USDT")
        return httpx.Response(200, json=ok_response({"accountEquity": 4321.09}))

    client = make_client(handler)
    assert await client.get_balance() == 4321.09


async def test_get_retries_on_429_then_succeeds():
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={})
        return httpx.Response(200, json=ok_response({"accountEquity": 1}))

    client = make_client(handler)
    balance = await client.get_balance()

    assert balance == 1
    assert attempts["count"] == 2


async def test_get_raises_after_exhausting_retries_on_429():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "0"}, json={})

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="rate limit exceeded"):
        await client.get_balance()


async def test_get_raises_on_nonzero_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": "400100", "msg": "Invalid KC-API-SIGN"})

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="Invalid KC-API-SIGN"):
        await client.get_balance()


async def test_get_raises_on_http_error_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    client = make_client(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_balance()


async def test_connection_true_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_response({"accountEquity": 1}))

    client = make_client(handler)
    assert await client.test_connection() is True


async def test_connection_false_on_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    client = make_client(handler)
    assert await client.test_connection() is False
