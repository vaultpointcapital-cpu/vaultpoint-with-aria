"""Money & Currency Layer — FX rate producer
(supabase/migrations/20260804000000_add_money_currency_layer.sql).

Fetches rate_to_usd for every currency this app actually holds and writes
both the Redis cache (fx:{currency}, read by src/lib/fx.ts on the Next.js
side — same shared Upstash instance) and an audit row in fx_rates. This
module only ever produces; src/lib/fx.ts is a reader only.

Crypto/stablecoins: CoinGecko's public /simple/price endpoint, no API key.
Deviates from the PRD's literal suggestion ("Binance/Bybit tickers —
already polled") — those tickers quote crypto-to-crypto pairs (e.g.
BTCUSDT), which would still need a USDT-to-USD rate to get a true USD
figure, the exact thing being solved here. CoinGecko's vs_currencies=usd
gives a direct USD-denominated rate already, including for USDT/USDC
themselves — critically, their LIVE traded rate, never a hardcoded 1.00
peg (a depeg is exactly the moment a user opens the app, and insisting
USDT is $1.00 during one is the dashboard users stop trusting).

Fiat: Open Exchange Rates, gated on OPEN_EXCHANGE_RATES_APP_ID — unset
means this leg logs and skips (no vendor account exists in this
environment yet), same placeholder treatment as Paystack Transfers/Stripe
Connect in the wallet build.

NGN dual-rate (§6) — PROVISIONAL, PENDING FOUNDER SIGN-OFF: the OXR fetch
is stored with source='cbn_official'. There is no free parallel-market
NGN feed to wire up automatically; a source='parallel_market' row only
ever appears via manual insert (Table Editor, or a future admin tool)
until a real source is chosen. src/lib/fx.ts's getRate('NGN') already
prefers a recent parallel_market row over the official one when present.
"""

import logging
from datetime import UTC, datetime

import httpx

from .config import settings
from .redis_cache import cache_fx_rate
from .supabase_client import get_service_client

logger = logging.getLogger("broker_sync")

COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3"
OXR_BASE_URL = "https://openexchangerates.org/api"

# CoinGecko coin id -> the currency code this app stores in fx_rates/positions.currency.
CRYPTO_COINGECKO_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "USDT": "tether",
    "USDC": "usd-coin",
}

FIAT_CURRENCIES = ["NGN", "GHS", "KES", "GBP", "EUR"]

# Portfolio Risk Aggregator (services/broker-sync/app/portfolio_risk/) —
# these exist purely to price a position's non-USD currency leg to USD
# for exposure/concentration math (e.g. a EURJPY position's JPY leg),
# not for the wallet/Money-Layer purpose FIAT_CURRENCIES above serves.
# XAU/XAG (gold/silver) are quoted the same way a fiat cross is (USD per
# ounce), so they ride the same OXR fetch as everything else here.
FX_MAJOR_CURRENCIES = ["JPY", "AUD", "CAD", "CHF", "NZD", "XAU", "XAG"]


async def _store_rate(currency: str, rate_to_usd: str, source: str) -> None:
    supabase = get_service_client()
    fetched_at = datetime.now(UTC).isoformat()

    supabase.table("fx_rates").insert(
        {"currency": currency, "rate_to_usd": rate_to_usd, "source": source, "fetched_at": fetched_at}
    ).execute()

    await cache_fx_rate(currency, rate_to_usd, source, fetched_at)


async def _refresh_crypto_rates() -> None:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{COINGECKO_BASE_URL}/simple/price",
            params={"ids": ",".join(CRYPTO_COINGECKO_IDS.values()), "vs_currencies": "usd"},
        )
        response.raise_for_status()
        payload = response.json()

    for currency, coingecko_id in CRYPTO_COINGECKO_IDS.items():
        usd_price = payload.get(coingecko_id, {}).get("usd")
        if usd_price is None:
            logger.warning("fx_service: CoinGecko returned no USD price for %s", currency)
            continue
        await _store_rate(currency, str(usd_price), "coingecko")


async def _refresh_fiat_rates() -> None:
    if not settings.open_exchange_rates_app_id:
        logger.info("fx_service: OPEN_EXCHANGE_RATES_APP_ID not set — skipping fiat leg")
        return

    # FX_MAJOR_CURRENCIES rides this same fetch/store pipeline — same OXR
    # call, same fx_rates table, same fx:{currency} Redis cache — rather
    # than a second fetch loop. See FX_MAJOR_CURRENCIES's own comment for
    # why these are fetched (Portfolio Risk Aggregator currency-leg
    # pricing) even though FIAT_CURRENCIES above serves a different
    # (wallet/Money-Layer) purpose.
    all_currencies = FIAT_CURRENCIES + FX_MAJOR_CURRENCIES

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{OXR_BASE_URL}/latest.json",
            params={"app_id": settings.open_exchange_rates_app_id, "symbols": ",".join(all_currencies)},
        )
        response.raise_for_status()
        payload = response.json()

    # OXR quotes USD -> currency (e.g. 1 USD = 1538 NGN); fx_rates stores
    # the inverse, rate_to_usd (1 unit of currency = this many USD).
    rates = payload.get("rates", {})
    for currency in all_currencies:
        usd_to_currency = rates.get(currency)
        if not usd_to_currency:
            logger.warning("fx_service: Open Exchange Rates returned no rate for %s", currency)
            continue
        rate_to_usd = 1 / usd_to_currency
        source = "cbn_official" if currency == "NGN" else "openexchangerates"
        await _store_rate(currency, f"{rate_to_usd:.8f}", source)


async def refresh_fx_rates() -> None:
    await _refresh_crypto_rates()
    await _refresh_fiat_rates()
