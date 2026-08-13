import type { MoneyJSON } from '@/lib/money';
import type { AriaRegion } from '@/lib/aria/region';
import type { Reality } from '@/types/database';

// Aria Context Builder — the one payload every Aria surface reads from.
// See src/lib/aria/context.ts's buildAriaContext(). Field-by-field
// privacy rule (D5): no API keys, tokens, account numbers, MT login
// ids, emails, phone numbers, full names, or Supabase user ids appear
// anywhere in this shape — holdings are referenced by label, connections
// by broker name only.

export interface AriaHolding {
  readonly label: string; // "BTC/USDT" — never an account number
  readonly assetClass: string;
  // In the holding's OWN currency, not displayCurrency — matches the
  // existing per-position figures this route already reported natively
  // before this builder existed, and never risks presenting a failed
  // FX conversion as a fabricated number (valueInDisplayCurrency can be
  // null on a Holding the aggregator couldn't price; value itself
  // never is).
  readonly value: MoneyJSON;
  readonly unrealisedPct: string | null;
  readonly reality: Reality;
  readonly liquidity: string;
  readonly stale: boolean;
  readonly asOf: string;
}

export type AriaConfidence = 'full' | 'partial' | 'unusable';

export interface AriaContext {
  readonly version: '1';
  readonly generatedAt: string;

  readonly user: {
    readonly displayCurrency: string;
    readonly region: AriaRegion;
    readonly tier: 'free' | 'pro' | 'elite';
    readonly timezone: string; // best-effort approximation — see region.ts
  };

  readonly portfolio: {
    readonly totalAssets: MoneyJSON; // real only — excludes simulated/pending
    readonly byAssetClass: Record<string, MoneyJSON>;
    readonly dayChangePct: string | null; // null when not computable (no prior snapshot)
    readonly holdings: readonly AriaHolding[];
    readonly excludedHoldings: readonly AriaHolding[]; // simulated + pending
    readonly unpricedCount: number;
  };

  readonly dataQuality: {
    readonly stale: boolean;
    readonly oldestAsOf: string;
    readonly degradedSources: readonly string[]; // broker labels only, no ids
    readonly confidence: AriaConfidence;
  };

  readonly compliance: {
    readonly coolDownActive: boolean;
    readonly coolDownReason: string | null;
    readonly disclaimerRequired: boolean;
    readonly regionNotes: readonly string[];
  };

  readonly pods: readonly {
    readonly label: string;
    readonly target: MoneyJSON;
    readonly current: MoneyJSON;
    readonly daysRemaining: number | null;
  }[];
}
