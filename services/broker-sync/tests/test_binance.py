import hashlib
import hmac
from urllib.parse import parse_qsl, urlencode

import httpx
import pytest

from app.brokers.binance import BinanceClient


def make_client(handler) -> BinanceClient:
    """A BinanceClient wired to a fake transport instead of the real network."""
    client = BinanceClient(api_key="test-key", api_secret="test-secret")
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://fapi.binance.com"
    )
    return client


def position_row(**overrides) -> dict:
    row = {
        "symbol": "BTCUSDT",
        "positionAmt": "0.5",
        "entryPrice": "60000",
        "markPrice": "61200",
        "leverage": "10",
        "marginType": "cross",
        "isolatedMargin": "0",
        "positionSide": "BOTH",
    }
    row.update(overrides)
    return row


def assert_valid_signature(request: httpx.Request) -> None:
    query = dict(parse_qsl(request.url.query.decode()))
    signature = query.pop("signature")
    expected = hmac.new(b"test-secret", urlencode(query).encode("utf-8"), hashlib.sha256).hexdigest()
    assert signature == expected
    assert request.headers["X-MBX-APIKEY"] == "test-key"
    assert "timestamp" in query
    assert query["recvWindow"] == "5000"


def test_sign_matches_binance_hmac_scheme():
    client = BinanceClient(api_key="test-key", api_secret="test-secret")
    query_string = "recvWindow=5000&timestamp=1700000000000"

    expected = hmac.new(b"test-secret", query_string.encode("utf-8"), hashlib.sha256).hexdigest()

    assert client._sign(query_string) == expected


async def test_get_positions_skips_zero_amount_rows():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/fapi/v2/positionRisk"
        assert_valid_signature(request)
        return httpx.Response(
            200,
            json=[
                position_row(symbol="SOLUSDT", positionAmt="0", entryPrice="0", markPrice="0"),
                position_row(symbol="ETHUSDT", positionAmt="-2", entryPrice="3000", markPrice="2900"),
            ],
        )

    client = make_client(handler)
    positions = await client.get_positions()

    assert len(positions) == 1
    position = positions[0]
    assert position.symbol == "ETHUSDT"
    assert position.side == "short"
    assert position.size == 2
    assert position.entry_price == 3000
    assert position.mark_price == 2900
    assert position.broker_source == "binance"
    assert position.unrealized_pnl == 200
    assert round(position.unrealized_pnl_pct, 2) == pytest.approx(3.33, abs=0.01)


async def test_get_positions_uses_position_side_in_hedge_mode():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                # In hedge mode Binance reports a SHORT leg's amount as
                # negative too — positionSide, not the sign, is authoritative.
                position_row(symbol="BTCUSDT", positionAmt="-0.5", positionSide="SHORT"),
            ],
        )

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions[0].side == "short"
    assert positions[0].size == 0.5


async def test_get_positions_reports_isolated_margin_only_when_isolated():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                position_row(marginType="isolated", isolatedMargin="1200"),
            ],
        )

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions[0].margin_used == 1200


async def test_get_positions_omits_margin_used_for_cross_margin():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[position_row(marginType="cross", isolatedMargin="0")])

    client = make_client(handler)
    positions = await client.get_positions()

    assert positions[0].margin_used is None


async def test_get_balance_returns_total_margin_balance():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/fapi/v2/account"
        assert_valid_signature(request)
        return httpx.Response(200, json={"totalMarginBalance": "9876.54"})

    client = make_client(handler)
    assert await client.get_balance() == 9876.54


async def test_get_retries_on_429_then_succeeds():
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={})
        return httpx.Response(200, json={"totalMarginBalance": "100"})

    client = make_client(handler)
    balance = await client.get_balance()

    assert balance == 100
    assert attempts["count"] == 2


async def test_get_raises_after_exhausting_retries_on_429():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "0"}, json={})

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="rate limit exceeded"):
        await client.get_balance()


async def test_get_raises_on_http_error_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": -1121, "msg": "Invalid symbol."})

    client = make_client(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_balance()


async def test_connection_true_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"totalMarginBalance": "1"})

    client = make_client(handler)
    assert await client.test_connection() is True


async def test_connection_false_on_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    client = make_client(handler)
    assert await client.test_connection() is False
