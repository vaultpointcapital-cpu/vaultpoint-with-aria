import asyncio
import base64
import hashlib
import hmac
import logging
import time
from typing import Optional

import httpx

from ..models import BrokerType, Position
from .base import BrokerClient

# KuCoin Futures — every call here is a GET against a read endpoint;
# nothing in this class ever places, amends, or cancels an order, or
# touches wallet transfer/withdraw endpoints.
KUCOIN_BASE_URL = "https://api-futures.kucoin.com"
MAX_RETRIES = 5
API_KEY_VERSION = "2"  # v2 keys require the passphrase itself to be HMAC-signed

logger = logging.getLogger("broker_sync")


class KucoinClient(BrokerClient):
    """KuCoin Futures REST, read-only. Positions from GET /api/v1/positions,
    account equity from GET /api/v1/account-overview.

    KuCoin reports position size as `currentQty` — a contract count, not
    underlying-asset quantity. get_positions() converts it using each
    symbol's multiplier from the public GET /api/v1/contracts/active
    endpoint (e.g. XBTUSDTM's multiplier of 0.001 means 1 contract =
    0.001 BTC), so `size` ends up in the same units Bybit/Binance report
    it in and calculate_position_value's size * price is correct for
    KuCoin rows too. Scoped to linear (USDT-margined) contracts, same as
    the Bybit/Binance clients — inverse/coin-margined contracts (where
    price and size relate differently) aren't handled.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: Optional[str] = None):
        super().__init__(api_key, api_secret, api_passphrase)
        if not api_passphrase:
            raise ValueError(
                "KucoinClient requires api_passphrase — KuCoin signs every request with one."
            )
        self._client = httpx.AsyncClient(base_url=KUCOIN_BASE_URL, timeout=10.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _sign(self, timestamp: str, method: str, endpoint: str, body: str = "") -> str:
        payload = f"{timestamp}{method}{endpoint}{body}"
        digest = hmac.new(
            self.api_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).digest()
        return base64.b64encode(digest).decode("utf-8")

    def _sign_passphrase(self) -> str:
        digest = hmac.new(
            self.api_secret.encode("utf-8"), self.api_passphrase.encode("utf-8"), hashlib.sha256
        ).digest()
        return base64.b64encode(digest).decode("utf-8")

    async def _request(self, path: str, params: Optional[dict] = None, signed: bool = True) -> dict | list:
        query_string = ""
        if params:
            query_string = "?" + "&".join(f"{k}={v}" for k, v in params.items())
        endpoint = f"{path}{query_string}"

        for attempt in range(MAX_RETRIES):
            headers = {}
            if signed:
                timestamp = str(int(time.time() * 1000))
                headers = {
                    "KC-API-KEY": self.api_key,
                    "KC-API-SIGN": self._sign(timestamp, "GET", endpoint),
                    "KC-API-TIMESTAMP": timestamp,
                    "KC-API-PASSPHRASE": self._sign_passphrase(),
                    "KC-API-KEY-VERSION": API_KEY_VERSION,
                }

            response = await self._client.get(endpoint, headers=headers)

            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue

            response.raise_for_status()
            body = response.json()
            if body.get("code") != "200000":
                raise RuntimeError(f"KuCoin API error {body.get('code')}: {body.get('msg')}")
            return body["data"]

        raise RuntimeError("KuCoin API rate limit exceeded after retries.")

    async def _get(self, path: str, params: Optional[dict] = None) -> dict | list:
        return await self._request(path, params, signed=True)

    async def _get_contract_multipliers(self) -> dict[str, float]:
        """GET /api/v1/contracts/active is public — signed here anyway
        would just be wasted work, KuCoin doesn't require auth for it.
        Fetched fresh per get_positions() call (a client's lifetime is
        one sync_connection call, so there's nothing longer-lived to
        cache it on) rather than hardcoded, since multipliers are set
        per-contract and do change.
        """
        rows = await self._request("/api/v1/contracts/active", signed=False)
        return {row["symbol"]: float(row["multiplier"]) for row in rows}

    async def get_positions(self) -> list[Position]:
        rows = await self._get("/api/v1/positions")
        open_rows = [row for row in rows if float(row["currentQty"]) != 0]
        if not open_rows:
            return []

        multipliers = await self._get_contract_multipliers()

        positions: list[Position] = []
        for row in open_rows:
            current_qty = float(row["currentQty"])
            symbol = row["symbol"]

            multiplier = multipliers.get(symbol)
            if multiplier is None:
                # Contract not in the active list (delisted mid-position?)
                # — report contract count rather than dropping the
                # position outright, but make the discrepancy loud.
                logger.warning(
                    "No contract multiplier found for KuCoin symbol=%s — "
                    "reporting raw contract count as size.",
                    symbol,
                )
                multiplier = 1.0

            side = "long" if current_qty > 0 else "short"
            mark_price = float(row["markPrice"]) if row.get("markPrice") else None

            positions.append(
                Position(
                    symbol=symbol,
                    side=side,
                    size=abs(current_qty) * multiplier,
                    entry_price=float(row["avgEntryPrice"]),
                    mark_price=mark_price,
                    leverage=float(row["realLeverage"]) if row.get("realLeverage") else 1,
                    unrealized_pnl=(
                        float(row["unrealisedPnl"]) if row.get("unrealisedPnl") is not None else None
                    ),
                    unrealized_pnl_pct=(
                        float(row["unrealisedPnlPcnt"]) * 100
                        if row.get("unrealisedPnlPcnt") is not None
                        else None
                    ),
                    margin_used=float(row["posMargin"]) if row.get("posMargin") else None,
                    broker_source=BrokerType.KUCOIN,
                )
            )
        return positions

    async def get_balance(self) -> float:
        data = await self._get("/api/v1/account-overview", {"currency": "USDT"})
        return float(data["accountEquity"])

    async def test_connection(self) -> bool:
        try:
            await self.get_balance()
            return True
        except Exception:
            return False
