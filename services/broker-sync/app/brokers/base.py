from abc import ABC, abstractmethod
from typing import Optional

from ..models import Position


class BrokerClient(ABC):
    """Every supported broker implements this. The scheduler and sync
    orchestration only ever call these three methods — no broker-specific
    branching anywhere outside this class hierarchy. Connections are
    strictly read-only: no implementation may call a trade-execution
    endpoint, even if the underlying API/key would allow it.

    api_passphrase is optional and broker-specific — KuCoin's signed
    endpoints require one on top of the key/secret; Bybit and Binance
    ignore it. Every subclass accepts it (even unused) so sync_service can
    construct any registered client the same way, without branching on
    broker name.
    """

    def __init__(self, api_key: str, api_secret: str, api_passphrase: Optional[str] = None):
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
