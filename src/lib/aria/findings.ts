import { createServiceClient } from '@/lib/supabase/server';
import type {
  AriaFinding as AriaFindingRow,
  AriaFindingSeverity,
  AriaFindingType,
  AriaFindingSourceAgent,
} from '@/types/database';

/**
 * Aria Pantheon — read/write helpers for public.aria_findings. Workers
 * (services/broker-sync/app/pantheon/*.py) write findings; this module is
 * the only TS-side write path (status transitions only — findings
 * themselves are Python-authored) and the only read path, shared by both
 * the reactive chat route (src/app/api/aria/chat/route.ts) and the
 * proactive cron route (src/app/api/aria/pantheon/proactive-check/route.ts).
 *
 * Uses the service-role client for every function here, even the
 * reactive read triggered by an authenticated user's own request —
 * aria_findings has no client-facing insert/update policy, and the
 * reactive route's own auth (the user is already verified logged-in
 * before this is ever called) is what actually scopes access, not RLS.
 */

const HERMES_FINDING_TTL_HOURS = 4;

export interface AriaFinding {
  id: string;
  sourceAgent: AriaFindingSourceAgent;
  findingType: AriaFindingType;
  severity: AriaFindingSeverity;
  rawData: Record<string, unknown>;
  createdAt: string;
}

function toAriaFinding(row: AriaFindingRow): AriaFinding {
  return {
    id: row.id,
    sourceAgent: row.source_agent,
    findingType: row.finding_type,
    severity: row.severity,
    rawData: row.raw_data,
    createdAt: row.created_at,
  };
}

/**
 * Findings not yet shown to the user, for the reactive chat route to
 * weave into its system prompt. A stale buy_signal (older than Hermes's
 * own 4h TTL) is excluded here as a read-side safety net — Hermes's own
 * run_hermes_scan() also flips its own stale 'new' rows to 'expired' at
 * the start of each run, but there's a window between runs where a
 * 'new' row could otherwise still be read as current.
 */
export async function getNewFindings(userId: string): Promise<AriaFinding[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('aria_findings')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'new')
    .order('created_at', { ascending: true });

  const rows = data ?? [];
  const cutoff = Date.now() - HERMES_FINDING_TTL_HOURS * 60 * 60 * 1000;

  return rows
    .filter((row) => row.finding_type !== 'buy_signal' || new Date(row.created_at).getTime() > cutoff)
    .map(toAriaFinding);
}

/**
 * Marks a whole fetched batch delivered together, not just findings the
 * model textually referenced — parsing "which findings got mentioned"
 * out of free-form prose is the same unreliable-inference problem this
 * route's own prohibited-language regex check (vs. trusting the model to
 * self-police) already avoids. Every fetched 'new' finding was already in
 * the prompt and the system prompt instructs weighing all of them, so the
 * whole batch is treated as delivered together.
 */
export async function markFindingsDelivered(findingIds: string[]): Promise<void> {
  if (findingIds.length === 0) return;

  const supabase = createServiceClient();
  await supabase
    .from('aria_findings')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .in('id', findingIds);
}

/**
 * Proactive candidates only: severity filtered to warning/critical at the
 * query level — this IS the structural enforcement of "caution/info never
 * proactive" (not a post-hoc check the caller could accidentally skip).
 * Grouped by user so the proactive route can synthesize one message per
 * user from however many findings are pending, rather than firing one
 * message per finding.
 */
export async function getPendingProactiveFindingsByUser(minAgeMinutes: number): Promise<Map<string, AriaFinding[]>> {
  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('aria_findings')
    .select('*')
    .eq('status', 'new')
    .in('severity', ['warning', 'critical'])
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true });

  const byUser = new Map<string, AriaFinding[]>();
  for (const row of data ?? []) {
    const existing = byUser.get(row.user_id);
    const finding = toAriaFinding(row);
    if (existing) {
      existing.push(finding);
    } else {
      byUser.set(row.user_id, [finding]);
    }
  }
  return byUser;
}

/**
 * The 30-min same-user proactive batching gate. Reads the most recent
 * delivered_at across ALL of this user's findings (not scoped to
 * proactive-only sends — a reactive chat delivery counts too) since
 * aria_findings' status transitions don't distinguish which route
 * triggered them. Treating a just-happened reactive delivery as "recently
 * touched" for gating purposes is a deliberate simplification: a user who
 * was just in chat with Aria doesn't need an immediate proactive nudge on
 * top of that.
 */
export async function minutesSinceLastProactiveDelivery(userId: string): Promise<number | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('aria_findings')
    .select('delivered_at')
    .eq('user_id', userId)
    .eq('status', 'delivered')
    .order('delivered_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.delivered_at) return null;
  return (Date.now() - new Date(data.delivered_at).getTime()) / (60 * 1000);
}
