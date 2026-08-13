"""Portfolio Risk Aggregator — pure exposure/drawdown math, no DB or I/O.

Correlation methodology (see the migration's header comment for the full
rationale): NOT a live statistical price-correlation matrix — currency/
asset-CLUSTER net exposure instead. An FX position decomposes into its
two currency legs (long EURJPY = long EUR notional, short JPY notional);
a crypto position is a single leg on its base asset. Summing these across
a book's open positions directly catches the PRD's own example ("five
uncorrelated-looking JPY-cross trades become one concentrated JPY bet")
without needing any historical-correlation infrastructure.
"""

from dataclasses import dataclass

# fx_service.py's FIAT_CURRENCIES + FX_MAJOR_CURRENCIES, plus USD itself
# (never looked up — implicitly rate 1.0). Symbols outside this set
# (equities tickers, unrecognized pairs) classify as None — excluded from
# concentration math, not guessed at.
_FX_CURRENCY_CODES = {"USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"}
_METAL_CODES = {"XAU", "XAG"}
_KNOWN_FX_BASE_CODES = _FX_CURRENCY_CODES | _METAL_CODES
# Longest-first doesn't actually matter here (endswith is an exact-suffix
# match, not a greedy strip), but ordered this way for readability.
_CRYPTO_QUOTE_SUFFIXES = ("USDT", "USDC", "BUSD", "USD")

_LONG_SIDES = {"long", "buy"}
_SHORT_SIDES = {"short", "sell"}


@dataclass(frozen=True)
class FxPair:
    base: str
    quote: str


@dataclass(frozen=True)
class CryptoAsset:
    base: str


def classify_symbol(symbol: str) -> FxPair | CryptoAsset | None:
    """A 6-character symbol whose two 3-char halves are both known FX/metal
    codes is an FxPair (e.g. EURJPY, XAUUSD). Otherwise, a symbol ending in
    a known crypto quote suffix is a CryptoAsset on its base (e.g. BTCUSDT
    -> BTC). Anything else is unclassified — the caller excludes it from
    concentration math rather than guessing.
    """
    if len(symbol) == 6:
        base, quote = symbol[:3], symbol[3:]
        if base in _KNOWN_FX_BASE_CODES and quote in _KNOWN_FX_BASE_CODES:
            return FxPair(base=base, quote=quote)

    for suffix in _CRYPTO_QUOTE_SUFFIXES:
        if symbol.endswith(suffix) and len(symbol) > len(suffix):
            return CryptoAsset(base=symbol[: -len(suffix)])

    return None


def _sign_for_side(side: str | None) -> float | None:
    if side in _LONG_SIDES:
        return 1.0
    if side in _SHORT_SIDES:
        return -1.0
    return None


def leg_notionals_usd(position: dict, fx_rates: dict[str, float]) -> dict[str, float]:
    """Decomposes one open position into its USD-equivalent currency-leg
    notionals. A currency missing from `fx_rates` is SKIPPED (that leg is
    simply absent from the result), never defaulted to a stale/guessed
    rate — the caller's aggregate will just slightly undercount that one
    leg rather than silently misprice it. `position` is a `positions`
    table row shape (symbol, side, size, entry_price, mark_price);
    `fx_rates` maps currency code -> rate_to_usd (fx_service.py's own
    convention: 1 unit of currency = this many USD). USD itself is never
    looked up — implicitly 1.0.
    """
    classified = classify_symbol(position.get("symbol") or "")
    if classified is None:
        return {}

    sign = _sign_for_side(position.get("side"))
    if sign is None:
        return {}

    size = position.get("size")
    if size is None:
        return {}
    size = float(size)

    mark_price = position.get("mark_price")
    if mark_price is None:
        mark_price = position.get("entry_price")
    if mark_price is None:
        return {}
    mark_price = float(mark_price)

    if isinstance(classified, CryptoAsset):
        # Already ~USD-denominated via the *USDT/*USDC/*USD quote
        # convention — no fx_rates lookup needed for this single leg.
        return {classified.base: sign * size * mark_price}

    def _rate_to_usd(currency: str) -> float | None:
        return 1.0 if currency == "USD" else fx_rates.get(currency)

    result: dict[str, float] = {}

    base_rate = _rate_to_usd(classified.base)
    if base_rate is not None:
        result[classified.base] = sign * size * base_rate

    quote_rate = _rate_to_usd(classified.quote)
    if quote_rate is not None:
        # size is in base-currency units (confirmed:
        # brokers/metatrader.py's volume(lots) * contractSize convention);
        # size * mark_price converts to quote-currency units. Long base =
        # short quote, hence the sign flip.
        result[classified.quote] = -sign * size * mark_price * quote_rate

    return result


def aggregate_book_exposure(positions: list[dict], fx_rates: dict[str, float]) -> dict[str, float]:
    """Net USD-equivalent exposure per currency/asset across every open
    position in a book — the number book_exposure_state stores and
    gate_check.is_concentration_capped() reads."""
    totals: dict[str, float] = {}
    for position in positions:
        for currency_or_asset, notional in leg_notionals_usd(position, fx_rates).items():
            totals[currency_or_asset] = totals.get(currency_or_asset, 0.0) + notional
    return totals


def compute_drawdown_pct(unrealized_pnl_sum: float, baseline_equity: float | None) -> float | None:
    """Signed percentage: negative means a loss against baseline_equity.
    None (not zero) when there's no meaningful baseline to compare
    against — the caller must never divide by zero or treat a missing
    baseline as "0% drawdown"."""
    if baseline_equity is None or baseline_equity <= 0:
        return None
    return (unrealized_pnl_sum / baseline_equity) * 100
