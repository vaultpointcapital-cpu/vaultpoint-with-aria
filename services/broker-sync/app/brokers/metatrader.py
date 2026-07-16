import asyncio
import logging
import uuid

import httpx

from ..models import BrokerType, Position
from .base import BrokerClient

# MT4/MT5 have no native REST API — this bridges through MetaApi
# (metaapi.cloud). Two different hosts: the provisioning/account-
# management API (create/deploy/inspect a cloud terminal) is fixed;
# the client API (read positions/account info) is region-scoped, only
# known once the account resource exists.
PROVISIONING_BASE_URL = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai"
MAX_RETRIES = 5
DEPLOY_POLL_INTERVAL_SECONDS = 5
DEPLOY_POLL_MAX_ATTEMPTS = 24  # ~2 minutes

logger = logging.getLogger("broker_sync")


class MetaTraderAccountNotReadyError(Exception):
    """The MetaApi cloud terminal isn't DEPLOYED+CONNECTED yet. Treated by
    sync_service the same as any other broker failure — stale data
    retained, error recorded, retried next cycle."""


class MetaTraderClient(BrokerClient):
    """MT4/MT5 via MetaApi — the only supported broker with no REST API
    of its own, and the only one with a fundamentally different
    credential shape. Its constructor takes login/password/server (the MT
    account itself) plus a service-level metaapi_token, not api_key/
    secret, so it doesn't share BrokerClient.__init__'s signature and
    sync_service constructs it differently (see the comment there
    explaining that disclosed exception to "nothing branches on broker
    name").

    account_id/region identify a MetaApi-provisioned cloud terminal —
    None on this connection's first sync. provision() is the one method
    here that writes anything: it creates and deploys that terminal. That
    is account/infrastructure provisioning, not a trade/order/transfer/
    withdraw action — it cannot place a trade or move money, only stand
    up the read-only bridge every other method in this class queries.
    """

    def __init__(
        self,
        login: str,
        password: str,
        server: str,
        platform: str,
        metaapi_token: str,
        account_id: str | None = None,
        region: str | None = None,
    ):
        self.login = login
        self.password = password
        self.server = server
        self.platform = platform
        self.metaapi_token = metaapi_token
        self.account_id = account_id
        self.region = region
        self._client = httpx.AsyncClient(timeout=20.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    @property
    def _headers(self) -> dict:
        return {"auth-token": self.metaapi_token}

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        headers = {**self._headers, **kwargs.pop("headers", {})}
        for attempt in range(MAX_RETRIES):
            response = await self._client.request(method, url, headers=headers, **kwargs)
            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue
            return response
        raise RuntimeError("MetaApi rate limit exceeded after retries.")

    async def _create_account(self) -> str:
        transaction_id = uuid.uuid4().hex
        payload = {
            "login": self.login,
            "password": self.password,
            "server": self.server,
            "platform": self.platform,
            "magic": 0,
            "name": f"vaultpoint-{self.login}",
        }

        for attempt in range(MAX_RETRIES):
            response = await self._request(
                "POST",
                f"{PROVISIONING_BASE_URL}/users/current/accounts",
                json=payload,
                headers={"transaction-id": transaction_id, "Content-Type": "application/json"},
            )
            if response.status_code == 202:
                # Processing — MetaApi's documented contract is to resubmit
                # with the same transaction-id after Retry-After.
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue
            if response.status_code not in (200, 201):
                raise RuntimeError(
                    f"MetaApi account creation failed ({response.status_code}): {response.text[:300]}"
                )
            return response.json()["id"]

        raise RuntimeError("MetaApi account creation did not complete after retries (stuck at 202).")

    async def provision(self) -> None:
        """Creates (if account_id is None) and deploys a MetaApi cloud
        terminal for this login/server, then polls until it's connected
        to the broker. Sets self.account_id/self.region on success — the
        caller is responsible for persisting those, so this only runs
        once per connection rather than on every poll cycle.
        """
        if self.account_id is None:
            self.account_id = await self._create_account()

        deploy_response = await self._request(
            "POST", f"{PROVISIONING_BASE_URL}/users/current/accounts/{self.account_id}/deploy"
        )
        if deploy_response.status_code not in (200, 204):
            raise RuntimeError(
                f"MetaApi deploy failed ({deploy_response.status_code}): {deploy_response.text[:300]}"
            )

        for _ in range(DEPLOY_POLL_MAX_ATTEMPTS):
            status_response = await self._request(
                "GET", f"{PROVISIONING_BASE_URL}/users/current/accounts/{self.account_id}"
            )
            status_response.raise_for_status()
            body = status_response.json()
            self.region = body.get("region")
            if body.get("state") == "DEPLOYED" and body.get("connectionStatus") == "CONNECTED":
                return
            await asyncio.sleep(DEPLOY_POLL_INTERVAL_SECONDS)

        raise MetaTraderAccountNotReadyError(
            f"MetaApi account {self.account_id} did not reach CONNECTED within the poll window."
        )

    def _client_api_host(self) -> str:
        if not self.account_id or not self.region:
            raise MetaTraderAccountNotReadyError("MetaApi account not provisioned yet — call provision() first.")
        return f"https://mt-client-api-v1.{self.region}.agiliumtrade.ai"

    async def _get_symbol_contract_sizes(self, symbols: set) -> dict:
        """MetaTraderPosition.volume is in lots, not underlying currency
        units — same class of gap KuCoin's currentQty had. contractSize
        comes from a per-symbol specification endpoint (no bulk endpoint
        exists here, unlike KuCoin's /contracts/active), so this fetches
        one request per distinct open symbol, not per position.
        """
        host = self._client_api_host()
        sizes: dict = {}
        for symbol in symbols:
            response = await self._request(
                "GET", f"{host}/users/current/accounts/{self.account_id}/symbols/{symbol}/specification"
            )
            if response.status_code != 200:
                logger.warning(
                    "Could not fetch contract size for MetaTrader symbol=%s (status=%s) — "
                    "reporting raw lot count as size.",
                    symbol,
                    response.status_code,
                )
                continue
            body = response.json()
            sizes[symbol] = float(body.get("contractSize", 1))
        return sizes

    async def get_positions(self) -> list[Position]:
        host = self._client_api_host()
        response = await self._request("GET", f"{host}/users/current/accounts/{self.account_id}/positions")
        if response.status_code != 200:
            raise RuntimeError(f"MetaApi positions request failed ({response.status_code}): {response.text[:300]}")

        rows = response.json()
        if not rows:
            return []

        contract_sizes = await self._get_symbol_contract_sizes({row["symbol"] for row in rows})

        positions: list[Position] = []
        for row in rows:
            side = "long" if row["type"] == "POSITION_TYPE_BUY" else "short"
            contract_size = contract_sizes.get(row["symbol"], 1.0)
            size = float(row["volume"]) * contract_size
            entry_price = float(row["openPrice"])
            mark_price = float(row["currentPrice"]) if row.get("currentPrice") is not None else None

            # Use MetaApi's own unrealizedProfit rather than this service's
            # calculate_position_pnl — it already accounts for point value/
            # swap conventions this naive price_diff * size formula doesn't.
            # pnl_pct is derived from that SAME figure (not recomputed via
            # calculate_position_pnl_pct) so the two numbers can't disagree
            # with each other over what "the position's PnL" actually is.
            unrealized_pnl = float(row["unrealizedProfit"]) if row.get("unrealizedProfit") is not None else None
            entry_value = entry_price * size
            unrealized_pnl_pct = (
                (unrealized_pnl / entry_value) * 100 if unrealized_pnl is not None and entry_value != 0 else None
            )

            positions.append(
                Position(
                    symbol=row["symbol"],
                    side=side,
                    size=size,
                    entry_price=entry_price,
                    mark_price=mark_price,
                    # MT margin/leverage are account-level, not per-position
                    # — no equivalent to Bybit's positionIM or Binance's
                    # isolatedMargin exists on MetatraderPosition, so these
                    # stay at the Position model's defaults (leverage=1,
                    # margin_used=None) rather than reporting a made-up figure.
                    unrealized_pnl=unrealized_pnl,
                    unrealized_pnl_pct=unrealized_pnl_pct,
                    broker_source=BrokerType.METATRADER,
                )
            )
        return positions

    async def get_balance(self) -> float:
        host = self._client_api_host()
        response = await self._request(
            "GET", f"{host}/users/current/accounts/{self.account_id}/account-information"
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"MetaApi account-information request failed ({response.status_code}): {response.text[:300]}"
            )
        return float(response.json()["equity"])

    async def test_connection(self) -> bool:
        try:
            await self.get_balance()
            return True
        except Exception:
            return False
