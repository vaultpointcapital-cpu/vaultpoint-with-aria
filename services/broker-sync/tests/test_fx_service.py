"""fx_service.py — the FX rate producer (Money & Currency Layer). Crypto/
stablecoin rates come from CoinGecko's public API (no key); fiat comes
from Open Exchange Rates, gated on OPEN_EXCHANGE_RATES_APP_ID. Both legs
write to fx_rates (via a FakeSupabase) and the Redis cache (mocked out
here — cache_fx_rate has its own contract, not re-tested per call)."""

import httpx
import pytest

from app import fx_service
from tests.conftest import FakeSupabase

_RealAsyncClient = httpx.AsyncClient


def _mock_client(handler):
    def _make_client(**_kwargs):
        return _RealAsyncClient(transport=httpx.MockTransport(handler), timeout=15)

    return _make_client


@pytest.fixture
def fake_supabase(monkeypatch):
    supabase = FakeSupabase()
    monkeypatch.setattr(fx_service, "get_service_client", lambda: supabase)
    return supabase


@pytest.fixture
def fake_cache(monkeypatch):
    calls = []

    async def _fake_cache_fx_rate(currency, rate_to_usd, source, fetched_at):
        calls.append((currency, rate_to_usd, source, fetched_at))

    monkeypatch.setattr(fx_service, "cache_fx_rate", _fake_cache_fx_rate)
    return calls


async def test_refresh_crypto_rates_uses_live_stablecoin_rate_not_hardcoded_peg(
    monkeypatch, fake_supabase, fake_cache
):
    """The spec's explicit warning: a stablecoin depeg is exactly the
    moment a user opens the app — USDT must never be hardcoded at 1.00."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "bitcoin": {"usd": 65000.5},
                "ethereum": {"usd": 3200.25},
                "tether": {"usd": 0.94},  # a real depeg, not 1.00
                "usd-coin": {"usd": 0.999},
            },
        )

    monkeypatch.setattr(fx_service.httpx, "AsyncClient", _mock_client(handler))

    await fx_service._refresh_crypto_rates()

    inserts = fake_supabase.calls_for("fx_rates", "insert")
    by_currency = {i.values["currency"]: i.values for i in inserts}

    assert by_currency["USDT"]["rate_to_usd"] == "0.94"
    assert by_currency["USDT"]["rate_to_usd"] != "1"
    assert by_currency["USDT"]["source"] == "coingecko"
    assert by_currency["BTC"]["rate_to_usd"] == "65000.5"
    assert len(fake_cache) == 4


async def test_refresh_fiat_rates_skips_cleanly_when_app_id_unset(monkeypatch, fake_supabase, fake_cache):
    monkeypatch.setattr(fx_service.settings, "open_exchange_rates_app_id", None)

    await fx_service._refresh_fiat_rates()

    assert fake_supabase.calls_for("fx_rates", "insert") == []
    assert fake_cache == []


async def test_refresh_fiat_rates_stores_ngn_as_cbn_official(monkeypatch, fake_supabase, fake_cache):
    monkeypatch.setattr(fx_service.settings, "open_exchange_rates_app_id", "test-app-id")

    def handler(request: httpx.Request) -> httpx.Response:
        # OXR quotes USD -> currency; fx_rates stores the inverse (rate_to_usd).
        return httpx.Response(200, json={"rates": {"NGN": 1538.0, "GHS": 15.5, "KES": 129.0, "GBP": 0.79, "EUR": 0.92}})

    monkeypatch.setattr(fx_service.httpx, "AsyncClient", _mock_client(handler))

    await fx_service._refresh_fiat_rates()

    inserts = fake_supabase.calls_for("fx_rates", "insert")
    ngn = next(i.values for i in inserts if i.values["currency"] == "NGN")

    assert ngn["source"] == "cbn_official"
    # rate_to_usd is stored rounded to 8dp — tolerance matches that, not
    # full float precision.
    assert abs(float(ngn["rate_to_usd"]) - (1 / 1538.0)) < 1e-8

    other = next(i.values for i in inserts if i.values["currency"] == "GBP")
    assert other["source"] == "openexchangerates"
