"""Deterministic SMC (Smart Money Concepts) structure detection — the
Scanner Service's rules engine (PRD Sprint 1, component 4A). Pure
functions on a normalized candle list, no I/O, no LLM call: the PRD is
explicit that Scanner detection must be a rules engine, not a model call
per candle (cost/latency). Aria/Claude only ever sees a candidate this
module has already produced (see signal_engine/scorer.py) — this module
never talks to Anthropic.

Candle shape (oldest first, closed candles only — the caller is
responsible for never handing this module an still-forming candle, which
would make every detection here re-fire and re-trigger on every partial
tick of that candle):

    {"timestamp": datetime, "open": float, "high": float, "low": float,
     "close": float, "volume": float}

Each detect_* function returns a list of detection dicts (usually 0 or 1
— multiple only if more than one distinct structure closes on the same
candle) with the shape scanner/service.py upserts directly into
candidate_setups: structure_type, direction, entry_zone_low/high,
stop_loss, take_profit, risk_reward_ratio, candle_timestamp,
raw_detection.

Codifies Pells' existing SMC ruleset only for the four structure types the
PRD names (liquidity sweep, BOS/CHoCH, order block retest, FVG fill) —
per the PRD's own non-goals, this is not new pattern research, and the
swing-point/impulse thresholds below are a reasonable, conservative
starting definition meant to be tuned against real market data in a later
sprint, not treated as final.
"""

from datetime import datetime
from typing import Literal, TypedDict


class Candle(TypedDict):
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


class Detection(TypedDict):
    structure_type: str
    direction: Literal["long", "short"]
    entry_zone_low: float
    entry_zone_high: float
    stop_loss: float
    take_profit: float
    risk_reward_ratio: float
    candle_timestamp: datetime
    raw_detection: dict


# Target reward as a multiple of risk (entry-to-stop distance) — applied
# uniformly across all four detectors so signal_scores/decision_gate can
# reason about "risk_reward_ratio" as one consistent number regardless of
# which structure produced the candidate. Tunable later; not exposed as a
# per-symbol config in this phase (PRD doesn't ask for that).
DEFAULT_RISK_REWARD_RATIO = 2.0

# A swing high/low is a fractal: the candle at index i is a swing high if
# its high is the strict max within [i - SWING_LOOKBACK, i + SWING_LOOKBACK].
# Only ever evaluated for i where both sides are fully available, i.e.
# never for the most recent SWING_LOOKBACK candles — a "swing point" isn't
# confirmed until candles on both sides exist.
SWING_LOOKBACK = 2

# A candle counts as an impulse (for order-block detection) if its body is
# at least this many times the average body size of the preceding window
# — a cheap, dependency-free stand-in for "a strong displacement move" that
# doesn't require ATR/volatility infrastructure this codebase doesn't have.
IMPULSE_BODY_MULTIPLE = 1.8
IMPULSE_LOOKBACK = 10

# Buffer added beyond the invalidation level when placing a stop-loss, as a
# fraction of that level's price — keeps the stop just outside the zone
# rather than exactly on it (a stop placed exactly at a swept level is the
# single most common way to get stopped out by noise on a true setup).
STOP_BUFFER_PCT = 0.0005


def _buffer(price: float) -> float:
    return price * STOP_BUFFER_PCT


def _take_profit(entry: float, stop_loss: float, direction: Literal["long", "short"]) -> float:
    risk = abs(entry - stop_loss)
    return entry + risk * DEFAULT_RISK_REWARD_RATIO if direction == "long" else entry - risk * DEFAULT_RISK_REWARD_RATIO


def _swing_points(candles: list[Candle]) -> tuple[list[int], list[int]]:
    """Returns (swing_high_indices, swing_low_indices) — fractal pivots
    confirmed by SWING_LOOKBACK candles on both sides."""
    highs: list[int] = []
    lows: list[int] = []
    n = len(candles)
    for i in range(SWING_LOOKBACK, n - SWING_LOOKBACK):
        window = candles[i - SWING_LOOKBACK : i + SWING_LOOKBACK + 1]
        if _is_strict_max(candles[i]["high"], window, "high", SWING_LOOKBACK):
            highs.append(i)
        if _is_strict_min(candles[i]["low"], window, "low", SWING_LOOKBACK):
            lows.append(i)
    return highs, lows


def _is_strict_max(value: float, window: list[Candle], key: str, pivot_offset: int) -> bool:
    for j, c in enumerate(window):
        if j != pivot_offset and c[key] >= value:
            return False
    return True


def _is_strict_min(value: float, window: list[Candle], key: str, pivot_offset: int) -> bool:
    for j, c in enumerate(window):
        if j != pivot_offset and c[key] <= value:
            return False
    return True


def detect_liquidity_sweep(candles: list[Candle]) -> list[Detection]:
    """A liquidity sweep: the most recent closed candle wicks beyond the
    nearest prior confirmed swing high/low, then closes back on the
    opposite side of it — price took out resting stop-loss liquidity
    above/below that level without accepting the new range, a classic SMC
    signal that the sweep was a stop-hunt, not the start of a breakout.
    Bearish sweep (of a swing high) => short; bullish sweep (of a swing
    low) => long.
    """
    if len(candles) < SWING_LOOKBACK * 2 + 2:
        return []

    last = candles[-1]
    # Swing points are computed over everything up to (but not including)
    # the last candle — the last candle is the one doing the sweeping, not
    # a confirmed pivot itself yet.
    history = candles[:-1]
    highs, lows = _swing_points(history)

    detections: list[Detection] = []

    if highs:
        swing_high = candles[highs[-1]]["high"]
        if last["high"] > swing_high and last["close"] < swing_high:
            stop_loss = last["high"] + _buffer(last["high"])
            entry = last["close"]
            detections.append(
                {
                    "structure_type": "liquidity_sweep",
                    "direction": "short",
                    "entry_zone_low": min(entry, swing_high),
                    "entry_zone_high": max(entry, swing_high),
                    "stop_loss": stop_loss,
                    "take_profit": _take_profit(entry, stop_loss, "short"),
                    "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                    "candle_timestamp": last["timestamp"],
                    "raw_detection": {
                        "swept_swing_high": swing_high,
                        "sweep_high": last["high"],
                        "close": last["close"],
                    },
                }
            )

    if lows:
        swing_low = candles[lows[-1]]["low"]
        if last["low"] < swing_low and last["close"] > swing_low:
            stop_loss = last["low"] - _buffer(last["low"])
            entry = last["close"]
            detections.append(
                {
                    "structure_type": "liquidity_sweep",
                    "direction": "long",
                    "entry_zone_low": min(entry, swing_low),
                    "entry_zone_high": max(entry, swing_low),
                    "stop_loss": stop_loss,
                    "take_profit": _take_profit(entry, stop_loss, "long"),
                    "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                    "candle_timestamp": last["timestamp"],
                    "raw_detection": {"swept_swing_low": swing_low, "sweep_low": last["low"], "close": last["close"]},
                }
            )

    return detections


def detect_bos_choch(candles: list[Candle]) -> list[Detection]:
    """Break of Structure (BOS): the last candle closes beyond the most
    recent confirmed swing point in the direction of the prevailing trend
    (higher-highs/higher-lows => uptrend, and vice versa) — trend
    continuation. Change of Character (CHoCH): the last candle closes
    beyond the most recent swing point AGAINST the prevailing trend — the
    first structural sign of a reversal. Both share the same break
    mechanics; only the label (and therefore the trading implication)
    differs based on trend context at the time of the break.
    """
    if len(candles) < SWING_LOOKBACK * 2 + 2:
        return []

    last = candles[-1]
    history = candles[:-1]
    highs, lows = _swing_points(history)
    if len(highs) < 2 or len(lows) < 2:
        return []  # not enough confirmed structure yet to characterize a trend

    trend = _prevailing_trend(candles, highs, lows)
    if trend is None:
        return []

    last_swing_high = candles[highs[-1]]["high"]
    last_swing_low = candles[lows[-1]]["low"]

    detections: list[Detection] = []

    if last["close"] > last_swing_high:
        structure_type = "bos" if trend == "up" else "choch"
        stop_loss = last_swing_low - _buffer(last_swing_low)
        entry = last["close"]
        detections.append(
            {
                "structure_type": structure_type,
                "direction": "long",
                "entry_zone_low": min(entry, last_swing_high),
                "entry_zone_high": max(entry, last_swing_high),
                "stop_loss": stop_loss,
                "take_profit": _take_profit(entry, stop_loss, "long"),
                "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                "candle_timestamp": last["timestamp"],
                "raw_detection": {"prevailing_trend": trend, "broken_level": last_swing_high, "close": last["close"]},
            }
        )
    elif last["close"] < last_swing_low:
        structure_type = "bos" if trend == "down" else "choch"
        stop_loss = last_swing_high + _buffer(last_swing_high)
        entry = last["close"]
        detections.append(
            {
                "structure_type": structure_type,
                "direction": "short",
                "entry_zone_low": min(entry, last_swing_low),
                "entry_zone_high": max(entry, last_swing_low),
                "stop_loss": stop_loss,
                "take_profit": _take_profit(entry, stop_loss, "short"),
                "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                "candle_timestamp": last["timestamp"],
                "raw_detection": {"prevailing_trend": trend, "broken_level": last_swing_low, "close": last["close"]},
            }
        )

    return detections


def _prevailing_trend(candles: list[Candle], highs: list[int], lows: list[int]) -> Literal["up", "down"] | None:
    """Higher high AND higher low over the last two confirmed swings =>
    up. Lower high AND lower low => down. Anything else (e.g. a higher
    high but lower low — an expanding range) is ambiguous, not a trend —
    returns None rather than guessing."""
    higher_high = candles[highs[-1]]["high"] > candles[highs[-2]]["high"]
    higher_low = candles[lows[-1]]["low"] > candles[lows[-2]]["low"]
    if higher_high and higher_low:
        return "up"
    if not higher_high and not higher_low:
        return "down"
    return None


def detect_order_block_retest(candles: list[Candle]) -> list[Detection]:
    """An order block is the last opposite-colored candle immediately
    before an impulsive (displacement) move — the last sell candle before
    a strong rally is a bullish order block; the last buy candle before a
    strong decline is a bearish order block. A retest fires when a LATER
    candle's range re-enters that order block's [low, high] zone, still
    within the same swing (i.e. the zone hasn't since been invalidated by
    price closing all the way through it).
    """
    if len(candles) < IMPULSE_LOOKBACK + 3:
        return []

    last = candles[-1]
    detections: list[Detection] = []

    for impulse_idx in range(len(candles) - IMPULSE_LOOKBACK, len(candles) - 1):
        impulse = candles[impulse_idx]
        if impulse_idx == 0:
            continue
        preceding = candles[max(0, impulse_idx - IMPULSE_LOOKBACK) : impulse_idx]
        if not preceding:
            continue
        avg_body = sum(abs(c["close"] - c["open"]) for c in preceding) / len(preceding)
        if avg_body <= 0:
            continue
        impulse_body = abs(impulse["close"] - impulse["open"])
        if impulse_body < avg_body * IMPULSE_BODY_MULTIPLE:
            continue

        impulse_up = impulse["close"] > impulse["open"]
        order_block_candle = candles[impulse_idx - 1]
        # A valid order block candle is the OPPOSITE color of the impulse
        # it precedes (the last sell before a rally, the last buy before a
        # decline) — same-colored candle immediately before an impulse is
        # just the start of the impulse itself, not a distinct order block.
        order_block_is_down = order_block_candle["close"] < order_block_candle["open"]
        if impulse_up and not order_block_is_down:
            continue
        if not impulse_up and order_block_is_down:
            continue

        zone_low = order_block_candle["low"]
        zone_high = order_block_candle["high"]

        # Invalidated if any candle between the impulse and now has already
        # closed all the way through the zone (the zone was "used up" and
        # this isn't a fresh retest anymore).
        between = candles[impulse_idx + 1 : -1]
        if impulse_up and any(c["close"] < zone_low for c in between):
            continue
        if not impulse_up and any(c["close"] > zone_high for c in between):
            continue

        retests = last["low"] <= zone_high and last["high"] >= zone_low
        if not retests:
            continue

        direction: Literal["long", "short"] = "long" if impulse_up else "short"
        stop_loss = zone_low - _buffer(zone_low) if direction == "long" else zone_high + _buffer(zone_high)
        entry = last["close"]
        detections.append(
            {
                "structure_type": "order_block_retest",
                "direction": direction,
                "entry_zone_low": zone_low,
                "entry_zone_high": zone_high,
                "stop_loss": stop_loss,
                "take_profit": _take_profit(entry, stop_loss, direction),
                "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                "candle_timestamp": last["timestamp"],
                "raw_detection": {
                    "order_block_index_from_end": impulse_idx - 1 - (len(candles) - 1),
                    "impulse_body": impulse_body,
                    "avg_body": avg_body,
                },
            }
        )
        # One order block per scan is enough signal; don't keep scanning
        # further back in the same window for a second, weaker candidate.
        break

    return detections


def detect_fvg_fill(candles: list[Candle]) -> list[Detection]:
    """A Fair Value Gap (FVG) is a 3-candle imbalance: candle[i-2].high <
    candle[i].low (bullish gap — price left an untraded void behind on the
    way up) or candle[i-2].low > candle[i].high (bearish gap, on the way
    down). A fill fires when a later candle's range re-enters that gap.
    Scans every 3-candle window ending before the last candle for an
    unfilled gap, then checks whether the last candle is the one filling
    it.
    """
    if len(candles) < 4:
        return []

    last = candles[-1]
    detections: list[Detection] = []

    for i in range(2, len(candles) - 1):
        c0, c2 = candles[i - 2], candles[i]

        if c0["high"] < c2["low"]:
            gap_low, gap_high = c0["high"], c2["low"]
            direction: Literal["long", "short"] = "long"
        elif c0["low"] > c2["high"]:
            gap_low, gap_high = c2["high"], c0["low"]
            direction = "short"
        else:
            continue

        # Already-filled gaps (fully traded through by an earlier candle)
        # aren't live setups anymore.
        between = candles[i + 1 : -1]
        if direction == "long" and any(c["low"] < gap_low for c in between):
            continue
        if direction == "short" and any(c["high"] > gap_high for c in between):
            continue

        fills = last["low"] <= gap_high and last["high"] >= gap_low
        if not fills:
            continue

        stop_loss = gap_low - _buffer(gap_low) if direction == "long" else gap_high + _buffer(gap_high)
        entry = last["close"]
        detections.append(
            {
                "structure_type": "fvg_fill",
                "direction": direction,
                "entry_zone_low": gap_low,
                "entry_zone_high": gap_high,
                "stop_loss": stop_loss,
                "take_profit": _take_profit(entry, stop_loss, direction),
                "risk_reward_ratio": DEFAULT_RISK_REWARD_RATIO,
                "candle_timestamp": last["timestamp"],
                "raw_detection": {
                    "gap_low": gap_low,
                    "gap_high": gap_high,
                    "gap_candle_index_from_end": i - (len(candles) - 1),
                },
            }
        )
        break  # nearest unfilled gap is the relevant one; don't report stale ones too

    return detections


DETECTORS = {
    "liquidity_sweep": detect_liquidity_sweep,
    "bos_choch": detect_bos_choch,
    "order_block_retest": detect_order_block_retest,
    "fvg_fill": detect_fvg_fill,
}


def detect_all(candles: list[Candle]) -> list[Detection]:
    """Runs every detector against the same candle window and flattens
    the results — scanner/service.py's single entry point per (symbol,
    timeframe). More than one structure can legitimately close on the
    same candle (e.g. a liquidity sweep that is also a CHoCH); each is
    upserted as its own candidate_setups row (structure_type is part of
    that table's unique constraint), left for the Signal Engine to judge
    independently rather than this module picking a winner.
    """
    detections: list[Detection] = []
    for detector in DETECTORS.values():
        detections.extend(detector(candles))
    return detections
