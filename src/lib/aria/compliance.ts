import { Money } from '@/lib/money';

// Aria Context Builder §5 — cool-down: a single-day drop >10% in REAL
// holdings pauses Aria's buy-side suggestions for the rest of that day.
// Computed from calculateNetWorthResult().total (today, live, already
// real-only via countsTowardNetWorth) against the most recent
// portfolio_snapshots row strictly before today (also real-only —
// _upsert_portfolio_snapshot filters .eq('reality','real')). Deliberately
// NOT reusing alert_engine.py's drawdown_pct: that figure is peak-relative
// (not day-over-day) and doesn't filter reality at all, which would let a
// simulated prop-account swing trigger a cool-down on the user's real
// portfolio — exactly the bug this spec exists to avoid.
const COOL_DOWN_DROP_THRESHOLD_PCT = 10;

export interface CoolDownResult {
  readonly active: boolean;
  readonly reason: string | null;
}

/**
 * yesterdayTotal is the most recent portfolio_snapshots row dated
 * strictly before today, already converted into todayTotal's currency
 * by the caller (a live fxService.convert() call — see context.ts; this
 * function does no currency conversion of its own, and both Money
 * values must already share a currency or Money.minus throws), or null
 * for a brand new user with no snapshot history yet — in which case
 * there's nothing to compare against, so cool-down is never active.
 * Granularity note: because portfolio_snapshots is once-daily, "24
 * hours" here means "for the rest of the calendar day the drop was
 * detected on," not a rolling 24h window from the exact drop timestamp
 * — the coarsest granularity the data actually supports, and
 * re-evaluates to false again once tomorrow's baseline snapshot exists.
 */
export function computeCoolDown(todayTotal: Money, yesterdayTotal: Money | null): CoolDownResult {
  if (yesterdayTotal === null) {
    return { active: false, reason: null };
  }

  if (yesterdayTotal.isZero() || yesterdayTotal.isNegative()) {
    return { active: false, reason: null };
  }

  const drop = yesterdayTotal.minus(todayTotal);
  if (drop.isNegative() || drop.isZero()) {
    return { active: false, reason: null }; // portfolio is flat or up
  }

  const dropPct = drop.ratioTo(yesterdayTotal).times(100);
  if (dropPct.lessThan(COOL_DOWN_DROP_THRESHOLD_PCT)) {
    return { active: false, reason: null };
  }

  return {
    active: true,
    reason: `Real portfolio value dropped ${dropPct.toFixed(1)}% today — new buy suggestions are paused until tomorrow.`,
  };
}

// Post-generation check (§5) — a regex/classifier pass over the model's
// output, not just a prompt instruction. Case-insensitive; returns the
// matched phrase (for a targeted "avoid this phrase" regeneration hint)
// or null. Not exhaustive — a starting set aimed at absolute/guarantee
// language, expandable as real false negatives surface in production.
const PROHIBITED_PATTERNS: readonly RegExp[] = [
  /guarantee(d)?/i,
  /risk[- ]free/i,
  /will (definitely |certainly )?go up/i,
  /100% sure/i,
  /can'?t lose/i,
  /sure thing/i,
  /no risk/i,
];

export function containsProhibitedLanguage(text: string): string | null {
  for (const pattern of PROHIBITED_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export const DISCLAIMER_TEXT =
  "\n\n_Aria is an AI assistant, not a licensed financial advisor. This is information, not a recommendation to buy, sell, or hold — you're responsible for your own decisions._";

// D4 — the exact fixed, non-model response for confidence: 'unusable'.
// A model asked to refuse will sometimes comply anyway; this is returned
// directly by the route without ever calling Anthropic.
export const UNUSABLE_CONFIDENCE_MESSAGE =
  "I can't see current data for your accounts right now, so I'd rather not comment on your portfolio than guess. Reconnect below and I'll pick this straight back up.";

// Used when the model's reply still contains prohibited language after
// one regeneration attempt — a safe, static fallback rather than a
// third model call or letting the flagged text through.
export const REGENERATION_FALLBACK_MESSAGE =
  "I want to be careful not to overstate anything here — let me put it plainly instead: I can't guarantee any outcome, and I'd rather you ask me a more specific question about your portfolio than get a vague reassurance from me.";
