"""Detects Signal Mode / Managed Mode positions that have closed on the
broker side and records their realized PnL into signal_outcomes.

Before this module existed, nothing anywhere in this codebase ever wrote
to signal_outcomes — track record stats, managed_mode.py's daily-loss
kill switch, and profit-share billing all READ it, but it was always
empty, silently making all three non-functional. This hooks into
sync_connection's existing position-reconciliation step: _get_stale_positions
already computes exactly which (symbol, side) positions were open last
poll and are no longer reported this poll — that disappearance is this
module's trigger to check "was this a Signal Mode/Managed Mode trade,
and if so, what did it realize?"

Matching a closed position back to the signal_action that opened it is
NOT exact for Bybit — its default one-way position mode merges every
order on a symbol+side into a single net position, and a TP/SL-triggered
close is executed by a Bybit-generated closing order with no reliable
link back to the entry order's orderId/orderLinkId exposed in the V5
closed-pnl response. MetaTrader deals carry a positionId, but this
service never captures it at order-placement time (MetaApi only assigns
one on fill, not on the pending-order response place_order returns), so
the same practical limitation applies there.

Given that, this only ever attributes a closed position to a specific
signal_action when there is EXACTLY ONE unmatched executed signal_action
for that connection+symbol+side, and the closed size is within
CLOSED_SIZE_TOLERANCE_PCT of what was recorded as executed_size.
Ambiguous cases (more than one candidate, or a size mismatch beyond
tolerance) are logged and left unmatched rather than guessed — an
under-attributed trade (missed for billing/kill-switch purposes until
someone reconciles it manually) is the safe failure direction; a
wrongly-attributed one is not, especially with real money billing off
of this.
"""

import asyncio
import logging
from datetime import UTC, datetime

from .models import BrokerType

logger = logging.getLogger("broker_sync")

CLOSED_SIZE_TOLERANCE_PCT = 5.0
BREAKEVEN_PNL_THRESHOLD = 0.01


async def detect_and_record_outcomes(supabase, client, connection: dict, stale_positions: list[dict]) -> None:
    """stale_positions: rows from positions with at least id/symbol/side/
    synced_at, for (symbol, side) pairs that were open last poll and are
    gone this poll. `client` must still be open — callers must not
    aclose() it until after this returns.
    """
    connection_id = connection["id"]
    broker = connection["broker"]

    for stale in stale_positions:
        try:
            await _detect_one(supabase, client, broker, connection_id, stale)
        except Exception:
            # One bad symbol's reconciliation failing must never block the
            # rest, and must never fail the poll cycle itself — position
            # sync (the primary job) already completed by the time this
            # runs. Left unmatched for the next cycle or manual review.
            logger.exception(
                "signal_outcomes: detection failed for connection=%s symbol=%s side=%s",
                connection_id,
                stale.get("symbol"),
                stale.get("side"),
            )


async def _detect_one(supabase, client, broker: str, connection_id: str, stale: dict) -> None:
    symbol = stale.get("symbol")
    side = stale.get("side")
    since = stale.get("synced_at")
    if not symbol or not side or not since:
        return

    candidates = await asyncio.to_thread(_find_unmatched_candidates, supabase, connection_id, symbol, side)
    if not candidates:
        return  # not a Signal Mode/Managed Mode position — nothing to do

    if len(candidates) > 1:
        logger.warning(
            "signal_outcomes: %d unmatched executed signal_actions for connection=%s symbol=%s side=%s — "
            "ambiguous (position merging means realized PnL can't be safely split between them), "
            "skipping automatic attribution. Needs manual reconciliation.",
            len(candidates),
            connection_id,
            symbol,
            side,
        )
        return

    candidate = candidates[0]

    if broker == BrokerType.BYBIT.value:
        realized_pnl, closed_size = await _fetch_bybit_closed_pnl(client, symbol, since)
    elif broker == BrokerType.METATRADER.value:
        realized_pnl, closed_size = await _fetch_metatrader_closed_pnl(client, symbol, since)
    else:
        return  # no closed-PnL source for this broker — Binance/KuCoin never execute trades

    if realized_pnl is None:
        return  # broker call failed or returned nothing usable — already logged inside the fetch helper

    executed_size = candidate.get("executed_size")
    if executed_size and closed_size is not None:
        size_diff_pct = abs(closed_size - executed_size) / executed_size * 100
        if size_diff_pct > CLOSED_SIZE_TOLERANCE_PCT:
            logger.warning(
                "signal_outcomes: closed size %.6f differs from executed_size %.6f by %.1f%% for "
                "signal_action=%s — beyond %.0f%% tolerance, skipping automatic attribution.",
                closed_size,
                executed_size,
                size_diff_pct,
                candidate["id"],
                CLOSED_SIZE_TOLERANCE_PCT,
            )
            return

    result, r_multiple = _classify_outcome(candidate, realized_pnl)

    await asyncio.to_thread(
        lambda: supabase.table("signal_outcomes")
        .insert(
            {
                "signal_action_id": candidate["id"],
                "result": result,
                "realized_pnl": realized_pnl,
                "realized_r_multiple": r_multiple,
            }
        )
        .execute()
    )
    logger.info(
        "signal_outcomes: recorded %s (pnl=%.2f) for signal_action=%s (connection=%s symbol=%s side=%s)",
        result,
        realized_pnl,
        candidate["id"],
        connection_id,
        symbol,
        side,
    )


def _find_unmatched_candidates(supabase, connection_id: str, symbol: str, side: str) -> list[dict]:
    actions_result = (
        supabase.table("signal_actions")
        .select("id, signal_id, executed_size")
        .eq("broker_connection_id", connection_id)
        .eq("action", "executed")
        .execute()
    )
    actions = actions_result.data or []
    if not actions:
        return []

    signal_ids = list({a["signal_id"] for a in actions})
    signals_result = (
        supabase.table("signals").select("id, pair, direction, entry_price, stop_loss").in_("id", signal_ids).execute()
    )
    signal_by_id = {s["id"]: s for s in (signals_result.data or [])}

    matching = []
    for action in actions:
        signal = signal_by_id.get(action["signal_id"])
        if signal and signal["pair"] == symbol and signal["direction"] == side:
            matching.append({**action, "signal": signal})

    if not matching:
        return []

    action_ids = [a["id"] for a in matching]
    outcomes_result = (
        supabase.table("signal_outcomes").select("signal_action_id").in_("signal_action_id", action_ids).execute()
    )
    already_matched = {o["signal_action_id"] for o in (outcomes_result.data or [])}

    return [a for a in matching if a["id"] not in already_matched]


def _classify_outcome(candidate: dict, realized_pnl: float) -> tuple[str, float | None]:
    if abs(realized_pnl) < BREAKEVEN_PNL_THRESHOLD:
        result = "breakeven"
    elif realized_pnl > 0:
        result = "win"
    else:
        result = "loss"

    signal = candidate["signal"]
    executed_size = candidate.get("executed_size")
    stop_distance = abs(signal["entry_price"] - signal["stop_loss"])

    r_multiple = None
    if executed_size and stop_distance > 0:
        risk_amount = executed_size * stop_distance
        if risk_amount > 0:
            r_multiple = realized_pnl / risk_amount

    return result, r_multiple


def _to_epoch_ms(iso_timestamp: str) -> int:
    return int(datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00")).timestamp() * 1000)


async def _fetch_bybit_closed_pnl(client, symbol: str, since_iso: str) -> tuple[float | None, float | None]:
    try:
        start_ms = _to_epoch_ms(since_iso)
    except ValueError:
        logger.warning("signal_outcomes: could not parse since_iso=%r for Bybit closed-pnl lookup", since_iso)
        return None, None

    end_ms = int(datetime.now(UTC).timestamp() * 1000)

    try:
        entries = await client.get_closed_pnl(symbol=symbol, start_time_ms=start_ms, end_time_ms=end_ms)
    except Exception:
        logger.exception("signal_outcomes: could not fetch Bybit closed-pnl for symbol=%s", symbol)
        return None, None

    if not entries:
        return None, None

    realized_pnl = sum(float(e["closedPnl"]) for e in entries)
    closed_size = sum(float(e["closedSize"]) for e in entries)
    return realized_pnl, closed_size


async def _fetch_metatrader_closed_pnl(client, symbol: str, since_iso: str) -> tuple[float | None, float | None]:
    now_iso = datetime.now(UTC).isoformat()

    try:
        deals = await client.get_history_deals(start_time=since_iso, end_time=now_iso)
    except Exception:
        logger.exception("signal_outcomes: could not fetch MetaTrader history deals for symbol=%s", symbol)
        return None, None

    closing_deals = [
        d for d in deals if d.get("symbol") == symbol and d.get("entryType") in ("DEAL_ENTRY_OUT", "DEAL_ENTRY_OUT_BY")
    ]
    if not closing_deals:
        return None, None

    realized_pnl = sum(
        float(d.get("profit", 0)) + float(d.get("commission", 0)) + float(d.get("swap", 0)) for d in closing_deals
    )
    # volume here is already in lots, the same unit executed_size was
    # recorded in for MT connections (see managed_mode.py's
    # _finalize_size) — no contract-size conversion needed for this
    # comparison, unlike get_positions()'s unit-normalized size.
    closed_size = sum(float(d.get("volume", 0)) for d in closing_deals)
    return realized_pnl, closed_size
