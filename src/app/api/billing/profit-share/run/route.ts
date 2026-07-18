import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getPreviousCalendarMonth, runProfitShareForUser } from '@/lib/billing/profit-share';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/billing/profit-share/run
 *
 * Bills every Elite-tier user's Aria-attributed profit for the previous
 * completed calendar month. Not wired to run automatically — this is the
 * callable endpoint only; scheduling it (Vercel Cron, or a manual trigger)
 * is a deliberate separate decision given real money moves when this runs,
 * not something to wire up silently alongside building the endpoint.
 *
 * Protected the same way Vercel's own Cron Jobs authenticate themselves:
 * `Authorization: Bearer $CRON_SECRET`. Using that exact convention (not a
 * custom header) means adding a vercel.json cron entry later needs no
 * extra plumbing — Vercel sends this header automatically for scheduled
 * invocations of routes that expect it.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret) {
    console.error('[billing/profit-share/run] CRON_SECRET is not set.');
    return apiError('INTERNAL_ERROR', 'Profit-share billing is not configured.');
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return apiError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }

  const supabase = createServiceClient();
  const { periodStart, periodEnd } = getPreviousCalendarMonth();

  const { data: eliteUsers, error } = await supabase
    .from('users')
    .select('id')
    .eq('subscription_tier', 'elite');

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load Elite users.');
  }

  const results = [];
  for (const user of eliteUsers ?? []) {
    try {
      results.push(await runProfitShareForUser(user.id, periodStart, periodEnd));
    } catch (err) {
      // A single user's billing run failing (a bug, a transient DB error)
      // must not stop the rest of the batch — logged and recorded as a
      // per-user result, not a 500 for the whole cycle.
      console.error(`[billing/profit-share/run] user=${user.id} threw unexpectedly:`, err);
      results.push({
        userId: user.id,
        status: 'failed' as const,
        attributedProfit: 0,
        feeAmount: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return apiSuccess({
    periodStart,
    periodEnd,
    usersProcessed: results.length,
    charged: results.filter((r) => r.status === 'charged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  });
}
