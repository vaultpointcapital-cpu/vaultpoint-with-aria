import asyncio
import hashlib
import hmac
import json
import time
from decimal import Decimal

import httpx

from ..financial import calculate_position_pnl, calculate_position_pnl_pct
from ..models import BrokerType, Position
from .base import BrokerClient

BYBIT_BASE_URL = "https://api.bybit.com"
RECV_WINDOW = "5000"
MAX_RETRIES = 5


class BybitClient(BrokerClient):
    """Bybit REST v5, unified trading account, linear (USDT perpetual)
    positions.

    get_positions/get_balance/test_connection (the shared BrokerClient
    interface every broker implements) stay strictly read-only, per
    base.py's own guarantee. place_order() below is NOT part of that
    shared interface — it's additive, Bybit-specific, and only ever
    called from the Signal Mode execution path (see
    app/signal_execution.py), never from sync_service's poll cycle. A
    connection must have broker_connections.trade_execution_enabled = true
    (which itself requires is_read_only = false, enforced by a DB CHECK
    constraint — see supabase/migrations/20260718000000_add_signal_mode.sql)
    before this method is ever reachable.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: str | None = None):
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

    async def _post(self, path: str, body: dict) -> dict:
        # Bybit v5 POST signing uses the raw JSON body string in place of
        # GET's query string — same formula otherwise (timestamp + api_key
        # + recv_window + payload), confirmed against Bybit's own
        # authentication docs before writing this rather than assumed from
        # the GET case. json.dumps must match byte-for-byte what's actually
        # sent on the wire, so this builds the string once and sends that
        # exact string as the request body (not letting httpx re-serialize
        # the dict separately, which could reorder keys and invalidate the
        # signature).
        body_str = json.dumps(body)

        for attempt in range(MAX_RETRIES):
            timestamp = str(int(time.time() * 1000))
            signature = self._sign(timestamp, body_str)
            headers = {
                "X-BAPI-API-KEY": self.api_key,
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-SIGN": signature,
                "X-BAPI-RECV-WINDOW": RECV_WINDOW,
                "Content-Type": "application/json",
            }

            response = await self._client.post(path, content=body_str, headers=headers)

            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2**attempt))
                await asyncio.sleep(retry_after)
                continue

            response.raise_for_status()
            result = response.json()
            if result.get("retCode") != 0:
                raise RuntimeError(f"Bybit API error {result.get('retCode')}: {result.get('retMsg')}")
            return result

        raise RuntimeError("Bybit API rate limit exceeded after retries.")

    async def place_order(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        entry_price: float,
        stop_loss: float,
        take_profit: float,
        order_link_id: str,
    ) -> str:
        """Places a GTC limit order at entry_price with stop-loss/take-
        profit attached at creation — not a market order. A signal's
        entry/stop/target are specific planned levels; filling at
        whatever the market happens to be when the user taps Execute
        (which could be long after the signal was generated) would be a
        materially different trade than the one they reviewed and
        approved. order_link_id must be unique per Bybit account —
        callers pass the signal_actions row's own id (as a string) so a
        retried request can't create a duplicate order.

        Returns Bybit's orderId. Raises on any failure — callers must
        not record a signal_actions row as 'executed' unless this
        returns successfully.
        """
        body = {
            "category": "linear",
            "symbol": symbol,
            "side": "Buy" if side == "long" else "Sell",
            "orderType": "Limit",
            "qty": str(qty),
            "price": str(entry_price),
            "timeInForce": "GTC",
            "stopLoss": str(stop_loss),
            "takeProfit": str(take_profit),
            "orderLinkId": order_link_id[:36],
        }
        result = await self._post("/v5/order/create", body)
        return result["result"]["orderId"]

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
                    leverage=float(row["leverage"]) if row.get("leverage") else 1,
                    unrealized_pnl=pnl,
                    unrealized_pnl_pct=pnl_pct,
                    margin_used=float(row["positionIM"]) if row.get("positionIM") else None,
                    broker_source=BrokerType.BYBIT,
                )
            )
        return positions

    async def get_closed_pnl(self, *, symbol: str, start_time_ms: int, end_time_ms: int) -> list[dict]:
        """GET /v5/position/closed-pnl — realized-PnL records for
        positions closed within [start_time_ms, end_time_ms]. Used only
        by app/signal_outcomes.py to reconcile a Signal Mode/Managed
        Mode execution against what the broker actually realized when
        the position closed; never used for live position display (that
        stays get_positions()'s job, unrealized PnL only).

        NOTE: written from Bybit's documented V5 response schema
        (closedPnl/closedSize/orderId/updatedTime per entry), not
        verified against a live closed trade. Verify against a real
        Bybit account before trusting this for a live billing run —
        same "flagged assumption, not silently final" treatment as
        every other unverified-against-a-live-broker number in this
        codebase.
        """
        body = await self._get(
            "/v5/position/closed-pnl",
            {
                "category": "linear",
                "symbol": symbol,
                "startTime": str(start_time_ms),
                "endTime": str(end_time_ms),
                "limit": "50",
            },
        )
        return body["result"]["list"]

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
