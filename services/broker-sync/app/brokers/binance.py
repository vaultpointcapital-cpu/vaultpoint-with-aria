import asyncio
import hashlib
import hmac
import time
from decimal import Decimal
from urllib.parse import urlencode

import httpx

from ..financial import calculate_position_pnl, calculate_position_pnl_pct
from ..models import BrokerType, Position
from .base import BrokerClient

# USD(S)-M Futures — the only Binance product with a "position" concept
# matching this service's Position schema (spot has balances, not
# leveraged positions). Every call here is a GET against a read endpoint;
# nothing in this class ever places, amends, or cancels an order, or
# touches wallet transfer/withdraw endpoints.
BINANCE_BASE_URL = "https://fapi.binance.com"
RECV_WINDOW = "5000"
MAX_RETRIES = 5


class BinanceClient(BrokerClient):
    """Binance USD(S)-M Futures REST, read-only. Positions come from
    /fapi/v2/positionRisk, account equity from /fapi/v2/account.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: str | None = None):
        super().__init__(api_key, api_secret, api_passphrase)
        self._client = httpx.AsyncClient(base_url=BINANCE_BASE_URL, timeout=10.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _sign(self, query_string: str) -> str:
        # Binance auth: HMAC-SHA256 over the exact query string sent
        # (including timestamp/recvWindow), hex digest, appended as a
        # trailing `signature` param. See Binance's futures "SIGNED
        # endpoint" docs.
        return hmac.new(
            self.api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    async def _get(self, path: str, params: dict) -> dict | list:
        for attempt in range(MAX_RETRIES):
            signed_params = {
                **params,
                "timestamp": str(int(time.time() * 1000)),
                "recvWindow": RECV_WINDOW,
            }
            query_string = urlencode(signed_params)
            signature = self._sign(query_string)
            headers = {"X-MBX-APIKEY": self.api_key}

            response = await self._client.get(
                f"{path}?{query_string}&signature={signature}", headers=headers
            )

            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue

            response.raise_for_status()
            return response.json()

        raise RuntimeError("Binance API rate limit exceeded after retries.")

    async def get_positions(self) -> list[Position]:
        rows = await self._get("/fapi/v2/positionRisk", {})

        positions: list[Position] = []
        for row in rows:
            position_amt = float(row["positionAmt"])
            if position_amt == 0:
                continue  # no open position on this symbol

            position_side = row.get("positionSide", "BOTH")
            if position_side == "LONG":
                side = "long"
            elif position_side == "SHORT":
                side = "short"
            else:
                # One-way mode: sign of positionAmt is the only side signal.
                side = "long" if position_amt > 0 else "short"

            size = abs(position_amt)
            entry_price = float(row["entryPrice"])
            mark_price = float(row["markPrice"]) if row.get("markPrice") else None
            leverage = float(row["leverage"]) if row.get("leverage") else 1

            isolated_margin = float(row["isolatedMargin"]) if row.get("isolatedMargin") else 0.0
            margin_used = isolated_margin if row.get("marginType") == "isolated" and isolated_margin > 0 else None

            pnl = None
            pnl_pct = None
            if mark_price is not None:
                # Decimal at the arithmetic boundary (D1) — converted back
                # to float only for the Position model, which stays float
                # (it's the broker-agnostic upsert shape, not itself a
                # money-precision-critical aggregation point).
                d_size, d_entry, d_mark = Decimal(str(size)), Decimal(str(entry_price)), Decimal(str(mark_price))
                pnl = float(calculate_position_pnl(side, d_size, d_entry, d_mark))
                pnl_pct = calculate_position_pnl_pct(side, d_size, d_entry, d_mark)

            positions.append(
                Position(
                    symbol=row["symbol"],
                    side=side,
                    size=size,
                    entry_price=entry_price,
                    mark_price=mark_price,
                    leverage=leverage,
                    unrealized_pnl=pnl,
                    unrealized_pnl_pct=pnl_pct,
                    margin_used=margin_used,
                    broker_source=BrokerType.BINANCE,
                )
            )
        return positions

    async def get_balance(self) -> float:
        body = await self._get("/fapi/v2/account", {})
        return float(body["totalMarginBalance"])

    async def test_connection(self) -> bool:
        try:
            await self.get_balance()
            return True
        except Exception:
            return False
