from abc import ABC, abstractmethod

from ..models import Position


class BrokerClient(ABC):
    """Every supported broker implements this. The scheduler and sync
    orchestration (sync_service.poll_all_connections and everything it
    calls) only ever use these three methods — no broker-specific
    branching anywhere in that path, and nothing reachable from a poll
    cycle ever places an order.

    That said: as of the Signal Mode workstream, BybitClient and
    MetaTraderClient each additionally expose a place_order() method
    that is NOT part of this shared interface — it's broker-specific,
    additive, and only reachable from the separate Signal Mode execution
    path (app/signal_execution.py), never from polling. A connection can
    only be used for execution if broker_connections.trade_execution_enabled
    is true, which itself requires is_read_only = false — enforced by a
    DB CHECK constraint, not just application logic (see
    supabase/migrations/20260718000000_add_signal_mode.sql). Binance and
    KuCoin have no place_order method; execution is deliberately scoped
    to the two brokers the Signal Mode spec named.

    api_passphrase is optional and broker-specific — KuCoin's signed
    endpoints require one on top of the key/secret; Bybit and Binance
    ignore it. Every subclass accepts it (even unused) so sync_service can
    construct any registered client the same way, without branching on
    broker name.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: str | None = None):
        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

    @abstractmethod
    async def get_positions(self) -> list[Position]:
        """Current open positions, normalized to the shared Position schema."""

    @abstractmethod
    async def get_balance(self) -> float:
        """Total account equity in USD (or USD-equivalent)."""

    @abstractmethod
    async def test_connection(self) -> bool:
        """Lightweight authenticated call to confirm the credentials work."""

    async def aclose(self) -> None:
        """Override to release held resources (e.g. an HTTP client)."""
        return None
