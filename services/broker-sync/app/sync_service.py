import asyncio
import logging
import random
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import httpx

from .brokers.base import BrokerClient
from .brokers.binance import BinanceClient
from .brokers.bybit import BybitClient
from .brokers.kucoin import KucoinClient
from .brokers.metatrader import MetaTraderClient
from .config import settings
from .connection_health_notifications import notify_health_change
from .encryption import decrypt
from .financial import calculate_position_value
from .models import BrokerType
from .pantheon.argus import evaluate_argus
from .pantheon.plutus import evaluate_plutus
from .redis_cache import cache_positions
from .signal_outcomes import detect_and_record_outcomes
from .supabase_client import get_service_client
from .sync_outcomes import SyncOutcome, classify_error

logger = logging.getLogger("broker_sync")

# Connection Health & Data Freshness — backoff formula: min(60 * 2**(n-1),
# 1800) * jitter(0.8..1.2), giving the sequence 1/2/4/8/16/30m as
# consecutive_failures climbs from 1 to 6+. AUTH_FAILED/ACCOUNT_CLOSED use
# a much longer fixed interval since retrying on the normal backoff
# schedule would never help — the credential/account itself needs fixing,
# not a shorter wait. 24h isn't a dedicated "never" sentinel (the spec
# explicitly avoids inventing one) — it's just long enough that the
# scheduler effectively stops touching the connection.
_BACKOFF_BASE_SECONDS = 60
_BACKOFF_CAP_SECONDS = 1800
_JITTER_RANGE = (0.8, 1.2)
_STALE_AFTER_FAILURES = 3  # degraded -> stale
_HALTED_RETRY_SECONDS = 24 * 60 * 60  # auth_failed / closed

# health -> the existing 4-state sync_status, maintained as a derived,
# backward-compatible view (see database.ts's HealthState comment) so
# GET /api/brokers and every other pre-existing sync_status consumer
# keeps working unchanged.
_DERIVED_SYNC_STATUS = {
    "pending": "pending",
    "healthy": "connected",
    "degraded": "error",
    "stale": "error",
    "auth_failed": "error",
    "closed": "disconnected",
}

# Bybit first, then Binance, then KuCoin, then MetaTrader (via MetaApi) —
# insertion order here is poll order. Adding a broker later means
# registering it here; nothing else in the sync/scheduler path branches
# on broker name — EXCEPT MetaTraderClient's construction below, which is
# a disclosed exception: MetaTrader's credentials (login/password/server
# + a service-level MetaApi token) don't fit the api_key/api_secret shape
# every other client uses, and it needs a lazy provisioning step the
# others don't. Keys are BrokerType members, not raw strings, so a
# typo'd broker name is an AttributeError at import time, not a client
# that silently never matches any connection.
BROKER_CLIENTS: dict[BrokerType, type[BrokerClient]] = {
    BrokerType.BYBIT: BybitClient,
    BrokerType.BINANCE: BinanceClient,
    BrokerType.KUCOIN: KucoinClient,
    BrokerType.METATRADER: MetaTraderClient,
}

CRYPTO_BROKERS = {BrokerType.BYBIT, BrokerType.BINANCE, BrokerType.KUCOIN}


async def sync_connection(connection: dict) -> None:
    """One broker_connections row -> live broker fetch -> normalize ->
    cache -> Supabase upsert. Never raises past this point: a failure on
    one connection is recorded on that row and logged, not propagated, so
    it can't take down the rest of a poll cycle.
    """
    supabase = get_service_client()
    connection_id = connection["id"]
    user_id = connection["user_id"]

    try:
        broker = BrokerType(connection["broker"])
    except ValueError:
        logger.error(
            "connection=%s has broker=%r, which isn't a BrokerType member — "
            "check constraint drift between the migration and models.py?",
            connection_id,
            connection["broker"],
        )
        return

    client_cls = BROKER_CLIENTS.get(broker)
    if client_cls is None:
        logger.debug(
            "No BrokerClient registered yet for broker=%s (connection=%s) — skipping.",
            broker.value,
            connection_id,
        )
        return

    if broker is BrokerType.METATRADER:
        client = await _build_metatrader_client(supabase, connection, broker)
    else:
        client = await _build_signed_client(supabase, client_cls, connection, broker)

    if client is None:
        # Error already recorded on the row by the builder above.
        return

    try:
        positions = await client.get_positions()
    except Exception as exc:
        # Keep last known data — don't wipe positions, don't touch
        # last_synced_at. Only the error/status fields change.
        logger.warning("Broker sync failed for connection=%s (%s): %s", connection_id, broker.value, exc)
        await _record_broker_exception(supabase, connection, broker, exc)
        await client.aclose()
        return

    rows = [
        {
            "user_id": user_id,
            "broker_connection_id": connection_id,
            "symbol": p.symbol,
            "side": p.side,
            "size": p.size,
            "entry_price": p.entry_price,
            "mark_price": p.mark_price,
            "leverage": p.leverage,
            "unrealized_pnl": p.unrealized_pnl,
            "unrealized_pnl_pct": p.unrealized_pnl_pct,
            "margin_used": p.margin_used,
        }
        for p in positions
    ]

    await cache_positions(connection_id, rows)

    stale = await asyncio.to_thread(_get_stale_positions, supabase, connection_id, rows)

    # Client stays open past here specifically so outcome detection can
    # make its own follow-up broker call (closed-pnl / history-deals) for
    # any position that just disappeared — closed BEFORE that call, never
    # after, so a slow reconciliation can't block the rest of the poll
    # cycle from completing on time.
    if stale:
        try:
            await detect_and_record_outcomes(supabase, client, connection, stale)
        except Exception:
            logger.exception(
                "signal_outcomes: detect_and_record_outcomes failed for connection=%s — "
                "position sync continues regardless.",
                connection_id,
            )

    # Prop-account breach heuristic (§ plan) — get_balance() is called
    # specifically for simulated connections because a closed/breached
    # prop challenge account can still return an empty (but successful)
    # position list; relying on get_positions() alone would miss that
    # case entirely. Heuristic and explicitly flagged: "account not
    # found" persisting after at least one prior successful sync is the
    # only signal available — no broker here exposes a real challenge-
    # rule-breach flag.
    outcome = SyncOutcome.SUCCESS
    error_code: str | None = None
    error_message: str | None = None

    if connection.get("account_type") == "simulated":
        try:
            await client.get_balance()
        except Exception as balance_exc:
            if (
                _looks_like_account_not_found(balance_exc)
                and connection.get("last_success_at") is not None
                and (connection.get("consecutive_failures") or 0) >= 1
            ):
                outcome = SyncOutcome.ACCOUNT_CLOSED
                error_code = "prop_account_not_found"
            else:
                outcome = classify_error(broker, balance_exc)
                error_code = outcome.value
            error_message = str(balance_exc)[:500]
            logger.warning(
                "get_balance failed for simulated connection=%s (%s): %s -> outcome=%s",
                connection_id,
                broker.value,
                balance_exc,
                outcome.value,
            )

    await client.aclose()

    await asyncio.to_thread(_reconcile_positions, supabase, connection_id, rows, stale)

    # Aria Pantheon — Argus (loss/risk) and Plutus (profit) evaluate this
    # cycle's already-fetched `rows` against the positions rows just
    # persisted above (needed for their dedup state columns,
    # argus_last_severity/plutus_last_severity). Guarded on account_type:
    # a simulated prop-challenge account swinging -20% must never trigger
    # a real-feeling loss warning, same real-only boundary
    # src/lib/aria/compliance.ts and _upsert_portfolio_snapshot already
    # enforce elsewhere.
    if connection.get("account_type") != "simulated":
        try:
            await evaluate_argus(supabase, connection, rows)
            await evaluate_plutus(supabase, connection, rows)
        except Exception:
            logger.exception(
                "pantheon: Argus/Plutus evaluation failed for connection=%s — position sync continues regardless.",
                connection_id,
            )

    await _apply_sync_outcome(supabase, connection, outcome, error_code=error_code, error_message=error_message)

    if outcome is SyncOutcome.SUCCESS:
        await asyncio.to_thread(_upsert_portfolio_snapshot, supabase, user_id)


async def _build_signed_client(
    supabase, client_cls: type[BrokerClient], connection: dict, broker: BrokerType
) -> BrokerClient | None:
    """Bybit/Binance/KuCoin all authenticate the same way: decrypt
    api_key/api_secret(/api_passphrase), construct the client. Returns
    None (with the row already marked as errored) on any failure.
    """
    connection_id = connection["id"]

    try:
        api_key = decrypt(connection["encrypted_api_key"], connection["api_key_iv"])
        api_secret = decrypt(connection["encrypted_api_secret"], connection["api_secret_iv"])
        api_passphrase = None
        if connection.get("encrypted_api_passphrase") and connection.get("api_passphrase_iv"):
            api_passphrase = decrypt(
                connection["encrypted_api_passphrase"], connection["api_passphrase_iv"]
            )
    except Exception:
        logger.exception("Failed to decrypt credentials for connection=%s", connection_id)
        await _apply_sync_outcome(
            supabase,
            connection,
            SyncOutcome.TRANSIENT,
            error_code="credential_decrypt_failed",
            error_message="Could not decrypt stored credentials.",
        )
        return None

    try:
        return client_cls(api_key, api_secret, api_passphrase=api_passphrase)
    except Exception as exc:
        # e.g. a KuCoin row that somehow reached here without a passphrase
        # despite the DB check constraint — construction failing loudly
        # here beats a confusing failure deeper inside get_positions().
        logger.exception("Failed to construct broker client for connection=%s", connection_id)
        await _record_broker_exception(supabase, connection, broker, exc)
        return None


async def _build_metatrader_client(
    supabase, connection: dict, broker: BrokerType
) -> MetaTraderClient | None:
    """MetaTrader needs the service-level METAAPI_TOKEN plus a decrypted
    MT password, and — unlike the other three — a lazily-provisioned
    MetaApi cloud terminal before it can serve any data at all. On a
    connection's first sync this provisions (create + deploy + wait for
    CONNECTED) and persists the resulting metaapi_account_id/region back
    to the row so subsequent polls skip straight to querying. Returns
    None (with the row already marked as errored) on any failure.
    """
    connection_id = connection["id"]

    if not settings.metaapi_token:
        logger.error("METAAPI_TOKEN is not configured — cannot sync connection=%s", connection_id)
        await _apply_sync_outcome(
            supabase,
            connection,
            SyncOutcome.TRANSIENT,
            error_code="metaapi_not_configured",
            error_message="MetaTrader support is not configured on this server.",
        )
        return None

    try:
        mt_password = decrypt(connection["encrypted_mt_password"], connection["mt_password_iv"])
    except Exception:
        logger.exception("Failed to decrypt MT password for connection=%s", connection_id)
        await _apply_sync_outcome(
            supabase,
            connection,
            SyncOutcome.TRANSIENT,
            error_code="credential_decrypt_failed",
            error_message="Could not decrypt stored credentials.",
        )
        return None

    client = MetaTraderClient(
        login=connection["mt_login"],
        password=mt_password,
        server=connection["mt_server"],
        platform=connection["mt_platform"],
        metaapi_token=settings.metaapi_token,
        account_id=connection.get("metaapi_account_id"),
        region=connection.get("metaapi_region"),
    )

    if client.account_id is None or client.region is None:
        try:
            await client.provision()
        except Exception as exc:
            logger.warning("MetaApi provisioning failed for connection=%s: %s", connection_id, exc)
            await _record_broker_exception(supabase, connection, broker, exc)
            await client.aclose()
            return None

        await asyncio.to_thread(
            lambda: supabase.table("broker_connections")
            .update({"metaapi_account_id": client.account_id, "metaapi_region": client.region})
            .eq("id", connection_id)
            .execute()
        )

    return client


def _get_stale_positions(supabase, connection_id: str, rows: list[dict]) -> list[dict]:
    """Rows in `positions` for this connection whose (symbol, side) is no
    longer in this cycle's freshly-fetched `rows` — i.e. positions that
    were open last poll and have since closed. Returns full rows
    (including synced_at, the last time each was confirmed still open)
    so app/signal_outcomes.py has what it needs to look up realized PnL
    for the window the position actually closed in; the delete itself
    happens later, in _reconcile_positions, after that lookup has had a
    chance to run.
    """
    open_keys = {(r["symbol"], r["side"]) for r in rows}

    existing = (
        supabase.table("positions")
        .select("id, symbol, side, synced_at")
        .eq("broker_connection_id", connection_id)
        .execute()
    )
    return [row for row in existing.data if (row["symbol"], row["side"]) not in open_keys]


def _reconcile_positions(supabase, connection_id: str, rows: list[dict], stale: list[dict]) -> None:
    """positions is "replaced/upserted on each poll cycle, not an
    append-only log" per the migration's own comment — so anything no
    longer reported by the broker gets deleted, not left stale forever.
    `stale` is _get_stale_positions's own output for this same cycle,
    passed in rather than recomputed so the two functions can never
    disagree on which rows are stale.
    """
    if stale:
        supabase.table("positions").delete().in_("id", [row["id"] for row in stale]).execute()

    if rows:
        supabase.table("positions").upsert(rows, on_conflict="broker_connection_id,symbol,side").execute()


_ACCOUNT_NOT_FOUND_PATTERNS = ("not found", "does not exist", "account not found", "404")


def _looks_like_account_not_found(exc: Exception) -> bool:
    """Best-effort heuristic (flagged, see the prop-breach comment in
    sync_connection) — no broker here exposes a real "this account was
    closed" signal, so this pattern-matches the same class of error
    message every broker client already raises for a 404/"not found"
    response."""
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
        return True
    text = str(exc).lower()
    return any(pattern in text for pattern in _ACCOUNT_NOT_FOUND_PATTERNS)


def _next_health(outcome: SyncOutcome, consecutive_failures: int) -> str:
    if outcome is SyncOutcome.SUCCESS:
        return "healthy"
    if outcome is SyncOutcome.AUTH_FAILED:
        return "auth_failed"
    if outcome is SyncOutcome.ACCOUNT_CLOSED:
        return "closed"
    # TRANSIENT / RATE_LIMITED
    return "stale" if consecutive_failures >= _STALE_AFTER_FAILURES else "degraded"


def _next_attempt_delay_seconds(outcome: SyncOutcome, consecutive_failures: int) -> float:
    if outcome is SyncOutcome.SUCCESS:
        return 0.0  # eligible for the very next poll cycle
    if outcome in (SyncOutcome.AUTH_FAILED, SyncOutcome.ACCOUNT_CLOSED):
        return _HALTED_RETRY_SECONDS * random.uniform(*_JITTER_RANGE)
    # TRANSIENT / RATE_LIMITED — 1/2/4/8/16/30m as consecutive_failures
    # climbs from 1 to 6+, per the backoff formula.
    base = min(_BACKOFF_BASE_SECONDS * (2 ** max(consecutive_failures - 1, 0)), _BACKOFF_CAP_SECONDS)
    return base * random.uniform(*_JITTER_RANGE)


async def _record_broker_exception(supabase, connection: dict, broker: BrokerType, exc: Exception) -> None:
    outcome = classify_error(broker, exc)
    await _apply_sync_outcome(supabase, connection, outcome, error_code=outcome.value, error_message=str(exc)[:500])


async def _apply_sync_outcome(
    supabase,
    connection: dict,
    outcome: SyncOutcome,
    *,
    error_code: str | None,
    error_message: str | None,
) -> None:
    """The one place broker_connections.health/sync_status/backoff get
    written — every failure path in this module (client construction,
    MetaApi provisioning, get_positions, the prop-breach get_balance
    check) funnels through here so the transition table and backoff
    formula can't drift between call sites. Writes a
    connection_health_events row only when health actually changes
    (it's an append-only transition log, not a per-cycle heartbeat), and
    always calls notify_health_change — that function's own dedup
    (notified_health_state) is what decides whether a notice actually
    goes out on cycles where health didn't just change (the 'stale'
    grace period and recovery notices both need that).
    """
    connection_id = connection["id"]
    now = datetime.now(UTC)
    now_iso = now.isoformat()

    current_health = connection.get("health") or "pending"
    prior_failures = connection.get("consecutive_failures") or 0
    consecutive_failures = 0 if outcome is SyncOutcome.SUCCESS else prior_failures + 1

    new_health = _next_health(outcome, consecutive_failures)
    delay_seconds = _next_attempt_delay_seconds(outcome, consecutive_failures)
    next_attempt_at = now + timedelta(seconds=delay_seconds)

    update: dict = {
        "health": new_health,
        "sync_status": _DERIVED_SYNC_STATUS[new_health],
        "last_attempt_at": now_iso,
        "consecutive_failures": consecutive_failures,
        "next_attempt_at": next_attempt_at.isoformat(),
        "last_error_code": error_code,
        "last_error": error_message,
    }
    if outcome is SyncOutcome.SUCCESS:
        update["last_success_at"] = now_iso
        update["last_synced_at"] = now_iso
    if new_health == "closed" and current_health != "closed":
        update["closed_at"] = now_iso
        update["closed_reason"] = "prop_breached" if outcome is SyncOutcome.ACCOUNT_CLOSED else "provider_closed"

    await asyncio.to_thread(
        lambda: supabase.table("broker_connections").update(update).eq("id", connection_id).execute()
    )

    if new_health != current_health:
        await asyncio.to_thread(
            lambda: supabase.table("connection_health_events")
            .insert(
                {
                    "connection_id": connection_id,
                    "from_health": current_health,
                    "to_health": new_health,
                    "error_code": error_code,
                }
            )
            .execute()
        )

    merged_connection = {**connection, **update}
    try:
        await notify_health_change(merged_connection, new_health)
    except Exception:
        logger.exception(
            "connection_health_notifications: notify_health_change failed for connection=%s — "
            "health transition itself was still recorded.",
            connection_id,
        )


def _get_rate_to_usd(supabase, currency: str, rates_used: dict[str, str]) -> tuple[Decimal | None, bool]:
    """Money & Currency Layer — synchronous DB read (this function runs
    inside asyncio.to_thread already, no Redis client wired in here, and
    this only runs once per user per day, so skipping the Redis cache
    layer src/lib/fx.ts reads is fine performance-wise; same fx_rates
    table, same source of truth). Records every rate actually used into
    `rates_used` — this becomes portfolio_snapshots.fx_rates, the D7
    reproducibility guarantee a historical read must replay against.
    Returns (None, False) if no rate is available at all — the caller
    excludes that holding rather than fabricating a rate (spec §5).
    """
    if currency == "USD":
        return Decimal(1), False

    # NGN dual-rate (§6, provisional pending founder sign-off) — prefer a
    # recent parallel-market row, same preference order as src/lib/fx.ts.
    if currency == "NGN":
        parallel = (
            supabase.table("fx_rates")
            .select("rate_to_usd, fetched_at")
            .eq("currency", "NGN")
            .eq("source", "parallel_market")
            .order("fetched_at", desc=True)
            .limit(1)
            .execute()
        )
        if parallel.data:
            fetched_at = datetime.fromisoformat(parallel.data[0]["fetched_at"])
            if (datetime.now(UTC) - fetched_at) <= timedelta(hours=24):
                rate = Decimal(str(parallel.data[0]["rate_to_usd"]))
                rates_used[currency] = str(rate)
                return rate, False

    result = (
        supabase.table("fx_rates")
        .select("rate_to_usd, fetched_at")
        .eq("currency", currency)
        .order("fetched_at", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None, False

    fetched_at = datetime.fromisoformat(result.data[0]["fetched_at"])
    stale = (datetime.now(UTC) - fetched_at) > timedelta(hours=24)
    rate = Decimal(str(result.data[0]["rate_to_usd"]))
    rates_used[currency] = str(rate)
    return rate, stale


def _upsert_portfolio_snapshot(supabase, user_id: str) -> None:
    """portfolio_snapshots is documented (migration comment + the hand
    written Update: never type) as an append-only, once-daily snapshot —
    NOT something this poll cycle should overwrite every 60s. So this
    only ever INSERTs the first time a given (user_id, today) row is
    missing; if today's snapshot already exists, it's left untouched.
    Flagged to the user: the spec asked to "upsert" this table on every
    poll, which would break that append-only invariant — this is the
    conservative reading until that's explicitly confirmed.

    Money & Currency Layer: every position/asset is converted to USD
    before summing (D5 — base currency is USD internally), and the exact
    rate map used is stored on the row (fx_rates, D7) — a historical read
    must replay against that map, never today's live rate. A holding
    whose currency has no rate available is excluded from the total, not
    fabricated as zero (spec §5) — this is a best-effort daily snapshot,
    not a user-facing error path, so there's no one to surface a warning
    to here; the exclusion just means today's total may be a slight
    undercount for that one holding.

    Connection Health & Data Freshness: degraded/degraded_sources flag
    whether any contributing connection's health wasn't 'healthy' at
    snapshot time — see the loop below. Doesn't affect any of the
    monetary figures; purely a disclosure flag consumers (currently
    net-worth-chart.tsx) can choose to act on.

    Valuation Contract: filters on positions.reality == 'real' directly
    (trigger-maintained — see
    supabase/migrations/20260805000000_add_valuation_contract.sql) rather
    than joining broker_connections and checking account_type inline, the
    same simplification the TS-side aggregator (src/lib/valuation/) gets.
    Known gap, not fixed here (out of scope for this pass): unlike the TS
    aggregator, this snapshot still only sums crypto/forex positions +
    manual assets — savings_pods and prop-account holdings aren't
    reflected in portfolio_snapshots' columns, so the historical chart can
    read lower than the live dashboard figure for a user with pod
    balances. Would need a new column, not just a filter change.
    """
    today = str(date.today())

    existing = (
        supabase.table("portfolio_snapshots")
        .select("id")
        .eq("user_id", user_id)
        .eq("snapshot_date", today)
        .execute()
    )
    if existing.data:
        return

    positions_result = (
        supabase.table("positions")
        .select("size, mark_price, entry_price, currency, broker_connections(broker, health, label)")
        .eq("user_id", user_id)
        .eq("reality", "real")
        .execute()
    )
    manual_result = supabase.table("manual_assets").select("value, currency").eq("user_id", user_id).execute()

    rates_used: dict[str, str] = {}
    any_stale = False
    crypto_value = Decimal(0)
    forex_value = Decimal(0)
    # Connection Health & Data Freshness — never fabricates a clean
    # number, same principle as an unpriced holding above: if any
    # contributing connection wasn't healthy at snapshot time, the
    # snapshot is flagged and the specific source(s) are named, not
    # silently included as if the data were current.
    degraded = False
    degraded_sources: list[dict] = []
    seen_degraded_labels: set[str] = set()

    for p in positions_result.data:
        broker_info = p.get("broker_connections")
        if isinstance(broker_info, list):
            broker_info = broker_info[0] if broker_info else None
        broker_info = broker_info or {}

        health = broker_info.get("health")
        label = broker_info.get("label") or "unknown"
        if health is not None and health != "healthy" and label not in seen_degraded_labels:
            degraded = True
            degraded_sources.append({"broker": broker_info.get("broker"), "label": label})
            seen_degraded_labels.add(label)

        rate, stale = _get_rate_to_usd(supabase, p.get("currency") or "USD", rates_used)
        if rate is None:
            continue  # unpriced — excluded, not zeroed (spec §5)
        any_stale = any_stale or stale

        value = calculate_position_value(
            Decimal(str(p["mark_price"])) if p["mark_price"] is not None else None,
            Decimal(str(p["entry_price"])),
            Decimal(str(p["size"])),
        ) * rate

        broker = broker_info.get("broker")
        if broker in CRYPTO_BROKERS:
            crypto_value += value
        else:
            forex_value += value

    manual_value = Decimal(0)
    for a in manual_result.data:
        rate, stale = _get_rate_to_usd(supabase, a.get("currency") or "USD", rates_used)
        if rate is None:
            continue
        any_stale = any_stale or stale
        manual_value += Decimal(str(a["value"])) * rate

    total_net_worth = crypto_value + forex_value + manual_value

    supabase.table("portfolio_snapshots").insert(
        {
            "user_id": user_id,
            "total_net_worth": str(total_net_worth),
            "crypto_value": str(crypto_value),
            "forex_value": str(forex_value),
            "manual_assets_value": str(manual_value),
            "currency": "USD",
            "fx_rates": rates_used,
            "rates_stale": any_stale,
            "degraded": degraded,
            "degraded_sources": degraded_sources,
            "snapshot_date": today,
        }
    ).execute()
