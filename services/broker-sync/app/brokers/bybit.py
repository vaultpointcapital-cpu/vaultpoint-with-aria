import asyncio
import hashlib
import hmac
import time
from typing import Optional

import httpx

from ..financial import calculate_position_pnl, calculate_position_pnl_pct
from ..models import BrokerType, Position
from .base import BrokerClient

BYBIT_BASE_URL = "https://api.bybit.com"
RECV_WINDOW = "5000"
MAX_RETRIES = 5


class BybitClient(BrokerClient):
    """Bybit REST v5, unified trading account, linear (USDT perpetual)
    positions. Read-only by construction — every call in this class is a
    GET against a read endpoint; nothing here ever places, amends, or
    cancels an order.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: Optional[str] = None):
        super().__init__(api_key, api_secret, api_passphrase)
        self._client = httpx.AsyncClient(base_url=BYBIT_BASE_URL, timeout=10.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _sign(self, timestamp: str, query_string: str) -> str:
        # Bybit v5 auth: HMAC-SHA256 over timestamp + api_key + recv_window
        # + query_string, hex digest. See Bybit's "Authentication" v5 docs.
        payload = f"{timestamp}{self.api_key}{RECV_WINDOW}{query_string}"
        return hmac.new(
            self.api_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    async def _get(self, path: str, params: dict) -> dict:
        query_string = "&".join(f"{k}={v}" for k, v in params.items())

        for attempt in range(MAX_RETRIES):
            timestamp = str(int(time.time() * 1000))
            signature = self._sign(timestamp, query_string)
            headers = {
                "X-BAPI-API-KEY": self.api_key,
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-SIGN": signature,
                "X-BAPI-RECV-WINDOW": RECV_WINDOW,
            }

            response = await self._client.get(path, params=params, headers=headers)

            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue

            response.raise_for_status()
            body = response.json()
            if body.get("retCode") != 0:
                raise RuntimeError(f"Bybit API error {body.get('retCode')}: {body.get('retMsg')}")
            return body

        raise RuntimeError("Bybit API rate limit exceeded after retries.")

    async def get_positions(self) -> list[Position]:
        body = await self._get("/v5/position/list", {"category": "linear", "settleCoin": "USDT"})
        rows = body["result"]["list"]

        positions: list[Position] = []
        for row in rows:
            size = float(row["size"])
            if size == 0:
                continue  # Bybit lists empty/closed slots too — skip them

            side = "long" if row["side"] == "Buy" else "short"
            entry_price = float(row["avgPrice"])
            mark_price = float(row["markPrice"]) if row.get("markPrice") else None

            pnl = None
            pnl_pct = None
            if mark_price is not None:
                pnl = calculate_position_pnl(side, size, entry_price, mark_price)
                pnl_pct = calculate_position_pnl_pct(side, size, entry_price, mark_price)

            positions.append(
                Position(
                    symbol=row["symbol"],
                    side=side,
                    size=size,
                    entry_price=entry_price,
                    mark_price=mark_price,
                    leverage=float(row["leverage"]) if row.get("leverage") else 1,
                    unrealized_pnl=pnl,
                    unrealized_pnl_pct=pnl_pct,
                    margin_used=float(row["positionIM"]) if row.get("positionIM") else None,
                    broker_source=BrokerType.BYBIT,
                )
            )
        return positions

    async def get_balance(self) -> float:
        body = await self._get("/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        accounts = body["result"]["list"]
        if not accounts:
            return 0.0
        return float(accounts[0]["totalEquity"])

    async def test_connection(self) -> bool:
        try:
            await self.get_balance()
            return True
        except Exception:
            return False
