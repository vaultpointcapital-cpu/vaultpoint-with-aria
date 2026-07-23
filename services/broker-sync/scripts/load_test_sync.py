"""
Track A load test: simulates 20-50 concurrent broker_connections going
through app.scheduler.poll_all_connections (the real orchestration code,
unmodified), to answer one question — does the sequential per-connection
poll loop stay inside poll_interval_seconds (60s, app/config.py) at beta
scale?

Does NOT hit any real broker, Supabase, or Redis. Everything external is
mocked with artificial latency sampled from a realistic range for each
dependency, because the question here is "does OUR orchestration logic
scale", not "how fast is a third-party API right now" — the latter isn't
something to load-test against real broker accounts anyway (rate limits,
no 20-50 real API keys available, and it wouldn't be reproducible).

Usage:
    python scripts/load_test_sync.py --connections 20
    python scripts/load_test_sync.py --connections 50 --failure-rate 0.1
"""

import argparse
import asyncio
import random
import sys
import time
from pathlib import Path
from statistics import mean, median

sys.path.insert(0, str(Path(__file__).parent.parent))

from app import scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from app.models import BrokerType  # noqa: E402

# Real-world round-trip ranges this simulates (seconds), sampled uniformly
# per call. Broker: typical read-only REST call to Bybit/Binance/KuCoin/
# MetaApi client API. Supabase/Redis: typical managed-Postgres/Redis
# round trip from a Railway-hosted service to Supabase/Upstash.
BROKER_CALL_LATENCY = (0.15, 0.60)
SUPABASE_CALL_LATENCY = (0.03, 0.12)
REDIS_CALL_LATENCY = (0.01, 0.05)

BROKERS = [BrokerType.BYBIT, BrokerType.BINANCE, BrokerType.KUCOIN, BrokerType.METATRADER]


class FakeResult:
    def __init__(self, data):
        self.data = data


class LoadTestQuery:
    """Minimal stand-in for supabase-py's fluent query builder, with a
    configurable artificial delay on execute() to simulate real Postgres
    round-trip time. Only implements what sync_service.py actually calls.
    """

    def __init__(self, table, connections_by_id):
        self.table_name = table
        self.connections_by_id = connections_by_id
        self.op = None
        self.values = None
        self._filters = {}
        self._single = False

    def select(self, *_a, **_kw):
        self.op = "select"
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def neq(self, col, val):
        return self

    def in_(self, col, vals):
        return self

    def update(self, values):
        self.op = "update"
        self.values = values
        return self

    def insert(self, values):
        self.op = "insert"
        self.values = values
        return self

    def upsert(self, rows, on_conflict=None):
        self.op = "upsert"
        self.values = rows
        return self

    def delete(self):
        self.op = "delete"
        return self

    def single(self):
        self._single = True
        return self

    def maybe_single(self):
        self._single = True
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        time.sleep(random.uniform(*SUPABASE_CALL_LATENCY))

        if self.op == "select":
            if self.table_name == "broker_connections":
                broker = self._filters.get("broker")
                rows = [c for c in self.connections_by_id.values() if c["broker"] == broker]
                return FakeResult(rows)
            if self.table_name == "positions":
                return FakeResult([])
            if self.table_name == "manual_assets":
                return FakeResult([])
            if self.table_name == "portfolio_snapshots":
                return FakeResult([{"id": "snap-1"}])  # pretend today's snapshot exists
            return FakeResult([] if not self._single else None)

        if self.op == "insert":
            rows = self.values if isinstance(self.values, list) else [self.values]
            return FakeResult([{**r, "id": "fake-id"} for r in rows])

        return FakeResult(None)


class LoadTestSupabase:
    def __init__(self, connections_by_id):
        self.connections_by_id = connections_by_id

    def table(self, name):
        return LoadTestQuery(name, self.connections_by_id)


def make_connections(n: int) -> dict:
    connections = {}
    for i in range(n):
        broker = BROKERS[i % len(BROKERS)]
        conn_id = f"conn-{i}"
        row = {
            "id": conn_id,
            "user_id": f"user-{i}",
            "broker": broker.value,
            "sync_status": "connected",
            "encrypted_api_key": "x",
            "api_key_iv": "x",
            "encrypted_api_secret": "x",
            "api_secret_iv": "x",
        }
        if broker == BrokerType.METATRADER:
            row.update(
                {
                    "mt_login": "12345",
                    "mt_server": "Test-Server",
                    "mt_platform": "mt5",
                    "encrypted_mt_password": "x",
                    "mt_password_iv": "x",
                    "metaapi_account_id": f"meta-{i}",
                    "metaapi_region": "london",
                }
            )
        connections[conn_id] = row
    return connections


def build_slow_client(failure_rate: float):
    """Returns a fake BrokerClient class whose get_positions() sleeps like
    a real broker round trip and randomly raises to simulate the failure
    rate a real fleet of broker connections would show (rate limits,
    expired keys, broker-side outages)."""

    class SlowClient:
        def __init__(self, *args, **kwargs):
            pass

        async def get_positions(self):
            await asyncio.sleep(random.uniform(*BROKER_CALL_LATENCY))
            if random.random() < failure_rate:
                raise RuntimeError("Simulated broker failure (rate limit / timeout)")
            return []

        async def aclose(self):
            pass

    return SlowClient


async def run_load_test(n_connections: int, failure_rate: float):
    connections = make_connections(n_connections)
    fake_supabase = LoadTestSupabase(connections)
    slow_client = build_slow_client(failure_rate)

    async def fake_decrypt(*_a, **_kw):
        return "decrypted"

    async def fake_cache_positions(*_a, **_kw):
        await asyncio.sleep(random.uniform(*REDIS_CALL_LATENCY))

    async def fake_acquire_lock():
        return True

    async def fake_release_lock():
        pass

    async def fake_heartbeat():
        pass

    # Patch every BrokerClient class the same way real sync_service.py
    # picks them (BROKER_CLIENTS dict), so this exercises the real
    # dispatch/routing logic, not a reimplementation of it.
    from app import sync_service

    original_clients = dict(sync_service.BROKER_CLIENTS)
    for broker in sync_service.BROKER_CLIENTS:
        sync_service.BROKER_CLIENTS[broker] = slow_client

    # MetaTrader doesn't go through BROKER_CLIENTS/_build_signed_client at
    # all — sync_connection special-cases it straight to
    # _build_metatrader_client, which constructs a real MetaTraderClient
    # and (for a connection with no metaapi_account_id/region yet) would
    # call provision() against MetaApi's real provisioning API. Patched
    # out entirely so this load test never makes a real network call.
    original_build_metatrader_client = sync_service._build_metatrader_client

    async def fake_build_metatrader_client(_supabase, _connection):
        return slow_client()

    sync_service._build_metatrader_client = fake_build_metatrader_client

    # sync_service does `from .encryption import decrypt`, binding the name
    # into its own module namespace — patching app.encryption.decrypt
    # afterward wouldn't touch that already-bound reference, so this patches
    # sync_service's own name for it instead.
    original_decrypt = sync_service.decrypt
    sync_service.decrypt = lambda *a, **kw: "decrypted"  # sync, matches real signature

    original_metaapi_token = settings.metaapi_token
    settings.metaapi_token = "fake-token-for-load-test"

    sync_service.get_service_client = lambda: fake_supabase
    sync_service.cache_positions = fake_cache_positions
    scheduler.get_service_client = lambda: fake_supabase
    scheduler.acquire_poll_lock = fake_acquire_lock
    scheduler.release_poll_lock = fake_release_lock
    scheduler.record_poll_heartbeat = fake_heartbeat

    per_connection_times: list[float] = []
    original_sync_connection = sync_service.sync_connection

    async def timed_sync_connection(connection):
        started = time.monotonic()
        try:
            await original_sync_connection(connection)
        finally:
            per_connection_times.append(time.monotonic() - started)

    scheduler.sync_connection = timed_sync_connection

    try:
        started = time.monotonic()
        await scheduler.poll_all_connections()
        elapsed = time.monotonic() - started
    finally:
        for broker, client in original_clients.items():
            sync_service.BROKER_CLIENTS[broker] = client
        sync_service.decrypt = original_decrypt
        sync_service._build_metatrader_client = original_build_metatrader_client
        settings.metaapi_token = original_metaapi_token

    return elapsed, per_connection_times


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--connections", type=int, default=20)
    parser.add_argument("--failure-rate", type=float, default=0.0)
    args = parser.parse_args()

    print(f"Simulating {args.connections} concurrent broker connections "
          f"(failure_rate={args.failure_rate:.0%})...")
    print(f"Budget: poll_interval_seconds = {settings.poll_interval_seconds}s\n")

    elapsed, per_connection_times = await run_load_test(args.connections, args.failure_rate)

    print(f"Total poll_all_connections() wall time: {elapsed:.2f}s")
    if per_connection_times:
        print(f"Per-connection latency: min={min(per_connection_times):.2f}s "
              f"mean={mean(per_connection_times):.2f}s "
              f"median={median(per_connection_times):.2f}s "
              f"max={max(per_connection_times):.2f}s")
    print(f"Connections processed: {len(per_connection_times)} / {args.connections}")

    if elapsed > settings.poll_interval_seconds:
        overage = elapsed - settings.poll_interval_seconds
        print(f"\nFAIL: cycle took {overage:.2f}s longer than the {settings.poll_interval_seconds}s "
              f"poll interval — connections would sync less often than advertised, and cycles "
              f"would start overlapping (mitigated by the poll lock, which would just skip the "
              f"overlapping cycle entirely rather than queue it).")
    else:
        headroom = settings.poll_interval_seconds - elapsed
        print(f"\nOK: {headroom:.2f}s of headroom under the {settings.poll_interval_seconds}s poll interval.")


if __name__ == "__main__":
    asyncio.run(main())
