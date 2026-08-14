import { z } from 'zod';
import type { Signal, SignalOutcome } from '@/types/database';

/**
 * Body for POST /api/signals/[id]/execute. size is the position size in
 * the instrument's native unit (lots for MetaTrader, contract qty for
 * Bybit) — the same "size" field the Python service's
 * POST /signals/{id}/execute expects, so this route can pass it through
 * without renaming.
 */
export const executeSignalSchema = z.object({
  brokerConnectionId: z.string().uuid('Select a broker connection'),
  size: z.coerce.number().positive('Size must be greater than 0'),
});

export type ExecuteSignalInput = z.infer<typeof executeSignalSchema>;

/**
 * Plain-English summary of a signal, e.g. "Long BTCUSDT — entry 65,000,
 * SL 63,000, TP 70,000 (R:R 2.5)". Mirrors describeAlert's role in
 * validations/alerts.ts: one shared formatter instead of duplicating
 * phrasing across the signal card and any future summary/notification.
 */
export function describeSignal(signal: Pick<Signal, 'pair' | 'direction' | 'entry_price' | 'stop_loss' | 'take_profit' | 'risk_reward_ratio'>): string {
  const dir = signal.direction === 'long' ? 'Long' : 'Short';
  return `${dir} ${signal.pair} — entry ${signal.entry_price.toLocaleString()}, SL ${signal.stop_loss.toLocaleString()}, TP ${signal.take_profit.toLocaleString()} (R:R ${signal.risk_reward_ratio.toFixed(1)})`;
}

export interface TrackRecordSummary {
  totalClosed: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number | null; // null when totalClosed is 0 — nothing to divide
  avgRMultiple: number | null;
}

/**
 * Aggregates a user's closed-signal outcomes into the win-rate/avg-R:R
 * stats Signal Mode's track record card shows. Pure function so it can
 * run identically server-side in signals/page.tsx's initial fetch and in
 * GET /api/signals/track-record's client-side refresh, without the two
 * ever disagreeing on the math.
 */
export function computeTrackRecord(outcomes: Pick<SignalOutcome, 'result' | 'realized_r_multiple'>[]): TrackRecordSummary {
  const totalClosed = outcomes.length;
  const wins = outcomes.filter((o) => o.result === 'win').length;
  const losses = outcomes.filter((o) => o.result === 'loss').length;
  const breakevens = outcomes.filter((o) => o.result === 'breakeven').length;

  const rMultiples = outcomes
    .map((o) => o.realized_r_multiple)
    .filter((r): r is number => r !== null);

  return {
    totalClosed,
    wins,
    losses,
    breakevens,
    winRatePct: totalClosed > 0 ? (wins / totalClosed) * 100 : null,
    avgRMultiple: rMultiples.length > 0 ? rMultiples.reduce((sum, r) => sum + r, 0) / rMultiples.length : null,
  };
}
