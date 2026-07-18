import json

import httpx
import pytest

from app.brokers import metatrader as metatrader_module
from app.brokers.metatrader import MetaTraderAccountNotReadyError, MetaTraderClient


def make_client(handler, **overrides) -> MetaTraderClient:
    defaults = dict(
        login="12345",
        password="investor-pass",
        server="Exness-MT5Real8",
        platform="mt5",
        metaapi_token="test-metaapi-token",
    )
    defaults.update(overrides)
    client = MetaTraderClient(**defaults)
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def account_status(state="DEPLOYED", connection_status="CONNECTED", region="london"):
    return {"_id": "acct-1", "state": state, "connectionStatus": connection_status, "region": region}


async def test_get_positions_raises_when_not_provisioned():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("should not make an HTTP call before provisioning")

    client = make_client(handler)
    with pytest.raises(MetaTraderAccountNotReadyError):
        await client.get_positions()


async def test_get_balance_raises_when_not_provisioned():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("should not make an HTTP call before provisioning")

    client = make_client(handler)
    with pytest.raises(MetaTraderAccountNotReadyError):
        await client.get_balance()


async def test_provision_creates_and_deploys_new_account(monkeypatch):
    monkeypatch.setattr(metatrader_module, "DEPLOY_POLL_INTERVAL_SECONDS", 0)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["auth-token"] == "test-metaapi-token"
        if request.method == "POST" and request.url.path == "/users/current/accounts":
            assert "transaction-id" in request.headers
            payload = json.loads(request.read())
            assert payload["login"] == "12345"
            assert payload["password"] == "investor-pass"
            assert payload["server"] == "Exness-MT5Real8"
            assert payload["platform"] == "mt5"
            return httpx.Response(201, json={"id": "new-account-id", "state": "DRAFT"})
        if request.method == "POST" and request.url.path == "/users/current/accounts/new-account-id/deploy":
            return httpx.Response(204)
        if request.method == "GET" and request.url.path == "/users/current/accounts/new-account-id":
            return httpx.Response(200, json=account_status())
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = make_client(handler)
    await client.provision()

    assert client.account_id == "new-account-id"
    assert client.region == "london"
    assert ("POST", "/users/current/accounts") in calls
    assert ("POST", "/users/current/accounts/new-account-id/deploy") in calls


async def test_provision_skips_create_when_account_id_already_set(monkeypatch):
    monkeypatch.setattr(metatrader_module, "DEPLOY_POLL_INTERVAL_SECONDS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path != "/users/current/accounts"  # never creates
        if request.url.path == "/users/current/accounts/existing-id/deploy":
            return httpx.Response(204)
        if request.url.path == "/users/current/accounts/existing-id":
            return httpx.Response(200, json=account_status())
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler, account_id="existing-id")
    await client.provision()

    assert client.account_id == "existing-id"
    assert client.region == "london"


async def test_provision_raises_if_never_connects(monkeypatch):
    monkeypatch.setattr(metatrader_module, "DEPLOY_POLL_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(metatrader_module, "DEPLOY_POLL_MAX_ATTEMPTS", 2)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts/existing-id/deploy":
            return httpx.Response(204)
        if request.url.path == "/users/current/accounts/existing-id":
            return httpx.Response(
                200, json=account_status(state="UNDEPLOYED", connection_status="DISCONNECTED")
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler, account_id="existing-id")
    with pytest.raises(MetaTraderAccountNotReadyError):
        await client.provision()


async def test_provision_retries_create_on_202(monkeypatch):
    monkeypatch.setattr(metatrader_module, "DEPLOY_POLL_INTERVAL_SECONDS", 0)
    attempts = {"count": 0}
    seen_transaction_ids = set()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts" and request.method == "POST":
            seen_transaction_ids.add(request.headers["transaction-id"])
            attempts["count"] += 1
            if attempts["count"] == 1:
                return httpx.Response(202, headers={"Retry-After": "0"})
            return httpx.Response(201, json={"id": "new-account-id"})
        if request.url.path == "/users/current/accounts/new-account-id/deploy":
            return httpx.Response(204)
        if request.url.path == "/users/current/accounts/new-account-id":
            return httpx.Response(200, json=account_status())
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler)
    await client.provision()

    assert attempts["count"] == 2
    assert len(seen_transaction_ids) == 1  # same transaction-id reused across the 202 retry


async def test_get_positions_converts_lots_using_contract_size():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts/acct-1/positions":
            return httpx.Response(
                200,
                json=[
                    {
                        "symbol": "EURUSD",
                        "type": "POSITION_TYPE_BUY",
                        "volume": 0.5,
                        "openPrice": 1.1000,
                        "currentPrice": 1.1050,
                        "unrealizedProfit": 250.0,
                    }
                ],
            )
        if request.url.path == "/users/current/accounts/acct-1/symbols/EURUSD/specification":
            return httpx.Response(200, json={"contractSize": 100000})
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler, account_id="acct-1", region="london")
    positions = await client.get_positions()

    assert len(positions) == 1
    position = positions[0]
    assert position.symbol == "EURUSD"
    assert position.side == "long"
    # 0.5 lots * 100000 contract size = 50000 units, not 0.5.
    assert position.size == 50000
    assert position.entry_price == 1.1
    assert position.mark_price == 1.105
    assert position.unrealized_pnl == 250.0
    assert position.leverage == 1
    assert position.margin_used is None
    assert position.broker_source == "metatrader"


async def test_get_positions_maps_sell_type_to_short():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts/acct-1/positions":
            return httpx.Response(
                200,
                json=[
                    {
                        "symbol": "GBPUSD",
                        "type": "POSITION_TYPE_SELL",
                        "volume": 1.0,
                        "openPrice": 1.3,
                        "currentPrice": 1.29,
                        "unrealizedProfit": 100.0,
                    }
                ],
            )
        if request.url.path == "/users/current/accounts/acct-1/symbols/GBPUSD/specification":
            return httpx.Response(200, json={"contractSize": 100000})
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler, account_id="acct-1", region="london")
    positions = await client.get_positions()

    assert positions[0].side == "short"


async def test_get_positions_falls_back_when_specification_fetch_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts/acct-1/positions":
            return httpx.Response(
                200,
                json=[
                    {
                        "symbol": "XAUUSD",
                        "type": "POSITION_TYPE_BUY",
                        "volume": 2.0,
                        "openPrice": 2000.0,
                        "currentPrice": 2010.0,
                        "unrealizedProfit": 20.0,
                    }
                ],
            )
        if request.url.path == "/users/current/accounts/acct-1/symbols/XAUUSD/specification":
            return httpx.Response(404, json={"error": "not found"})
        raise AssertionError(f"unexpected request: {request.url}")

    client = make_client(handler, account_id="acct-1", region="london")
    positions = await client.get_positions()

    # No contract size available — falls back to raw lot count.
    assert positions[0].size == 2.0


async def test_get_positions_returns_empty_without_fetching_specifications():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/users/current/accounts/acct-1/positions":
            return httpx.Response(200, json=[])
        raise AssertionError("should not fetch specifications with no open positions")

    client = make_client(handler, account_id="acct-1", region="london")
    positions = await client.get_positions()

    assert positions == []


async def test_get_positions_raises_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = make_client(handler, account_id="acct-1", region="london")
    with pytest.raises(RuntimeError, match="positions request failed"):
        await client.get_positions()


async def test_get_balance_returns_equity():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/users/current/accounts/acct-1/account-information"
        return httpx.Response(200, json={"balance": 1000.0, "equity": 987.65})

    client = make_client(handler, account_id="acct-1", region="london")
    assert await client.get_balance() == 987.65


async def test_get_balance_raises_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = make_client(handler, account_id="acct-1", region="london")
    with pytest.raises(RuntimeError, match="account-information request failed"):
        await client.get_balance()


async def test_get_retries_on_429_then_succeeds():
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"equity": 1.0})

    client = make_client(handler, account_id="acct-1", region="london")
    balance = await client.get_balance()

    assert balance == 1.0
    assert attempts["count"] == 2


async def test_get_raises_after_exhausting_retries_on_429():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "0"})

    client = make_client(handler, account_id="acct-1", region="london")
    with pytest.raises(RuntimeError, match="rate limit exceeded"):
        await client.get_balance()


async def test_connection_true_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"equity": 1.0})

    client = make_client(handler, account_id="acct-1", region="london")
    assert await client.test_connection() is True


async def test_connection_false_on_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = make_client(handler, account_id="acct-1", region="london")
    assert await client.test_connection() is False


class TestPlaceOrder:
    async def test_places_a_buy_limit_order_for_long(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["path"] = request.url.path
            captured["body"] = json.loads(request.read())
            return httpx.Response(
                200, json={"numericCode": 0, "stringCode": "TRADE_RETCODE_DONE", "orderId": "mt-order-1"}
            )

        client = make_client(handler, account_id="acct-1", region="london")
        order_id = await client.place_order(
            symbol="EURUSD",
            side="long",
            volume=0.5,
            entry_price=1.1,
            stop_loss=1.09,
            take_profit=1.12,
        )

        assert order_id == "mt-order-1"
        assert captured["path"] == "/users/current/accounts/acct-1/trade"
        assert captured["body"] == {
            "actionType": "ORDER_TYPE_BUY_LIMIT",
            "symbol": "EURUSD",
            "volume": 0.5,
            "openPrice": 1.1,
            "stopLoss": 1.09,
            "takeProfit": 1.12,
        }

    async def test_places_a_sell_limit_order_for_short(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.read())
            return httpx.Response(
                200, json={"numericCode": 0, "stringCode": "TRADE_RETCODE_DONE", "orderId": "mt-order-2"}
            )

        client = make_client(handler, account_id="acct-1", region="london")
        await client.place_order(
            symbol="GBPUSD",
            side="short",
            volume=1.0,
            entry_price=1.3,
            stop_loss=1.31,
            take_profit=1.27,
        )

        assert captured["body"]["actionType"] == "ORDER_TYPE_SELL_LIMIT"

    async def test_raises_when_account_not_provisioned(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("should not make an HTTP call before provisioning")

        client = make_client(handler)
        with pytest.raises(MetaTraderAccountNotReadyError):
            await client.place_order(
                symbol="EURUSD",
                side="long",
                volume=0.5,
                entry_price=1.1,
                stop_loss=1.09,
                take_profit=1.12,
            )

    async def test_raises_on_http_error_status(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        client = make_client(handler, account_id="acct-1", region="london")
        with pytest.raises(RuntimeError, match="trade request failed"):
            await client.place_order(
                symbol="EURUSD",
                side="long",
                volume=0.5,
                entry_price=1.1,
                stop_loss=1.09,
                take_profit=1.12,
            )

    async def test_raises_when_string_code_is_not_done(self):
        # A 200 response is not itself success — MetaApi returns 200 with
        # a rejection stringCode (e.g. requote, invalid stops, no money)
        # rather than a non-200 status. A caller checking only the HTTP
        # status would record a rejected order as 'executed'.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "numericCode": 10019,
                    "stringCode": "TRADE_RETCODE_NO_MONEY",
                    "message": "Not enough money",
                    "orderId": None,
                },
            )

        client = make_client(handler, account_id="acct-1", region="london")
        with pytest.raises(RuntimeError, match="TRADE_RETCODE_NO_MONEY"):
            await client.place_order(
                symbol="EURUSD",
                side="long",
                volume=0.5,
                entry_price=1.1,
                stop_loss=1.09,
                take_profit=1.12,
            )
