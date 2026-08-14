import hashlib
import hmac

import httpx
import pytest

from app.brokers.bybit import RECV_WINDOW, BybitClient


def make_client(handler) -> BybitClient:
    """A BybitClient wired to a fake transport instead of the real network."""
    client = BybitClient(api_key="test-key", api_secret="test-secret")
    client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api.bybit.com"
    )
    return client


def ok_response(result: dict) -> dict:
    return {"retCode": 0, "retMsg": "OK", "result": result}


def test_sign_matches_bybit_v5_hmac_scheme():
    client = BybitClient(api_key="test-key", api_secret="test-secret")
    timestamp = "1700000000000"
    query_string = "category=linear&settleCoin=USDT"

    expected_payload = f"{timestamp}test-key{RECV_WINDOW}{query_string}"
    expected = hmac.new(
        b"test-secret", expected_payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    assert client._sign(timestamp, query_string) == expected


async def test_get_positions_skips_zero_size_rows():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v5/position/list"
        return httpx.Response(
            200,
            json=ok_response(
                {
                    "list": [
                        {
                            "symbol": "BTCUSDT",
                            "side": "Buy",
                            "size": "0",
                            "avgPrice": "0",
                            "markPrice": "0",
                            "leverage": "10",
                            "positionIM": "0",
                        },
                        {
                            "symbol": "ETHUSDT",
                            "side": "Sell",
                            "size": "2",
                            "avgPrice": "3000",
                            "markPrice": "2900",
                            "leverage": "5",
                            "positionIM": "1200",
                        },
                    ]
                }
            ),
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
    assert position.leverage == 5
    assert position.margin_used == 1200
    assert position.broker_source == "bybit"
    assert position.unrealized_pnl == 200
    assert round(position.unrealized_pnl_pct, 2) == pytest.approx(3.33, abs=0.01)


async def test_get_positions_handles_missing_mark_price():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=ok_response(
                {
                    "list": [
                        {
                            "symbol": "BTCUSDT",
                            "side": "Buy",
                            "size": "1",
                            "avgPrice": "50000",
                            "markPrice": "",
                            "leverage": "",
                            "positionIM": "",
                        },
                    ]
                }
            ),
        )

    client = make_client(handler)
    positions = await client.get_positions()

    position = positions[0]
    assert position.side == "long"
    assert position.mark_price is None
    assert position.leverage == 1
    assert position.margin_used is None
    assert position.unrealized_pnl is None
    assert position.unrealized_pnl_pct is None


async def test_get_balance_returns_total_equity():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v5/account/wallet-balance"
        return httpx.Response(
            200, json=ok_response({"list": [{"totalEquity": "12345.67"}]})
        )

    client = make_client(handler)
    assert await client.get_balance() == 12345.67


async def test_get_balance_returns_zero_when_no_accounts():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_response({"list": []}))

    client = make_client(handler)
    assert await client.get_balance() == 0.0


async def test_get_retries_on_429_then_succeeds():
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={})
        return httpx.Response(200, json=ok_response({"list": []}))

    client = make_client(handler)
    balance = await client.get_balance()

    assert balance == 0.0
    assert attempts["count"] == 2


async def test_get_raises_after_exhausting_retries_on_429():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "0"}, json={})

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="rate limit exceeded"):
        await client.get_balance()


async def test_get_raises_on_nonzero_ret_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"retCode": 10001, "retMsg": "invalid signature", "result": {}}
        )

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="invalid signature"):
        await client.get_balance()


async def test_get_raises_on_http_error_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    client = make_client(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_balance()


async def test_connection_true_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_response({"list": [{"totalEquity": "1"}]}))

    client = make_client(handler)
    assert await client.test_connection() is True


async def test_connection_false_on_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    client = make_client(handler)
    assert await client.test_connection() is False


class TestPlaceOrder:
    async def test_places_a_limit_order_with_stop_loss_and_take_profit(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["path"] = request.url.path
            import json as _json

            captured["body"] = _json.loads(request.content)
            return httpx.Response(200, json=ok_response({"orderId": "order-123"}))

        client = make_client(handler)
        order_id = await client.place_order(
            symbol="BTCUSDT",
            side="long",
            qty=0.01,
            entry_price=65000,
            stop_loss=63000,
            take_profit=70000,
            order_link_id="signal-abc",
        )

        assert order_id == "order-123"
        assert captured["path"] == "/v5/order/create"
        assert captured["body"] == {
            "category": "linear",
            "symbol": "BTCUSDT",
            "side": "Buy",
            "orderType": "Limit",
            "qty": "0.01",
            "price": "65000",
            "timeInForce": "GTC",
            "stopLoss": "63000",
            "takeProfit": "70000",
            "orderLinkId": "signal-abc",
        }

    async def test_maps_short_direction_to_sell_side(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            import json as _json

            captured["body"] = _json.loads(request.content)
            return httpx.Response(200, json=ok_response({"orderId": "order-456"}))

        client = make_client(handler)
        await client.place_order(
            symbol="ETHUSDT",
            side="short",
            qty=1,
            entry_price=3000,
            stop_loss=3200,
            take_profit=2600,
            order_link_id="signal-def",
        )

        assert captured["body"]["side"] == "Sell"

    async def test_truncates_order_link_id_to_36_chars(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            import json as _json

            captured["body"] = _json.loads(request.content)
            return httpx.Response(200, json=ok_response({"orderId": "order-789"}))

        client = make_client(handler)
        long_id = "signal-" + "x" * 50
        await client.place_order(
            symbol="BTCUSDT",
            side="long",
            qty=0.01,
            entry_price=65000,
            stop_loss=63000,
            take_profit=70000,
            order_link_id=long_id,
        )

        assert len(captured["body"]["orderLinkId"]) == 36
        assert captured["body"]["orderLinkId"] == long_id[:36]

    async def test_signs_the_post_body_not_a_query_string(self):
        # Bybit v5 POST signing uses the raw JSON body string in the same
        # formula as GET's query string — verified against Bybit's own
        # authentication docs before implementing this. A wrong signature
        # scheme would make every real order request fail with a 401
        # from Bybit, never surfaced by a test that only checks the
        # request body content.
        client = BybitClient(api_key="test-key", api_secret="test-secret")
        import json as _json

        body = {"category": "linear", "symbol": "BTCUSDT"}
        body_str = _json.dumps(body)
        signature = client._sign("1700000000000", body_str)

        expected_payload = f"1700000000000test-key{RECV_WINDOW}{body_str}"
        expected = hmac.new(b"test-secret", expected_payload.encode("utf-8"), hashlib.sha256).hexdigest()
        assert signature == expected

    async def test_raises_on_broker_rejection(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"retCode": 110007, "retMsg": "insufficient available balance", "result": {}}
            )

        client = make_client(handler)
        with pytest.raises(RuntimeError, match="insufficient available balance"):
            await client.place_order(
                symbol="BTCUSDT",
                side="long",
                qty=0.01,
                entry_price=65000,
                stop_loss=63000,
                take_profit=70000,
                order_link_id="signal-fail",
            )


class TestGetClosedPnl:
    async def test_returns_the_raw_closed_pnl_entries(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["path"] = request.url.path
            captured["params"] = dict(request.url.params)
            return httpx.Response(
                200,
                json=ok_response(
                    {
                        "list": [
                            {
                                "symbol": "BTCUSDT",
                                "orderId": "order-999",
                                "closedPnl": "125.50",
                                "closedSize": "0.01",
                                "updatedTime": "1700000000000",
                            }
                        ]
                    }
                ),
            )

        client = make_client(handler)
        entries = await client.get_closed_pnl(symbol="BTCUSDT", start_time_ms=1699999000000, end_time_ms=1700001000000)

        assert captured["path"] == "/v5/position/closed-pnl"
        assert captured["params"] == {
            "category": "linear",
            "symbol": "BTCUSDT",
            "startTime": "1699999000000",
            "endTime": "1700001000000",
            "limit": "50",
        }
        assert entries == [
            {
                "symbol": "BTCUSDT",
                "orderId": "order-999",
                "closedPnl": "125.50",
                "closedSize": "0.01",
                "updatedTime": "1700000000000",
            }
        ]

    async def test_returns_an_empty_list_when_nothing_closed_in_the_window(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=ok_response({"list": []}))

        client = make_client(handler)
        entries = await client.get_closed_pnl(symbol="BTCUSDT", start_time_ms=0, end_time_ms=1)

        assert entries == []
