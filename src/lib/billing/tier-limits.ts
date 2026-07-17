/**
 * Single source of truth for tier-gated feature limits. Every feature
 * with a tier limit (Savings Pods today; more later) should read from
 * here, not duplicate the numbers — see src/lib/validations/pods.ts,
 * which delegates POD_LIMITS_BY_TIER to this.
 *
 * Deliberately has zero imports: this file is pulled in by
 * src/lib/validations/pods.ts, which is itself imported from a Client
 * Component (pods-client.tsx) for the UI's disabled-button state. Adding
 * a server-only import here (e.g. the Supabase server client, which
 * pulls in next/headers) would break that client bundle — see
 * getUserTier in ./get-user-tier.ts for the server-only counterpart.
 */
export const TIER_LIMITS = {
  free: { maxPods: 1 },
  pro: { maxPods: 10 },
  elite: { maxPods: Infinity },
} as const;
