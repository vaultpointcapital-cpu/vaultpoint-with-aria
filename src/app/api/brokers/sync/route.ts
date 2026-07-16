import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/brokers/sync
 *
 * Server-side proxy to the Python broker-sync service's
 * POST /sync/{user_id} — the browser never calls that service directly;
 * PYTHON_SERVICE_URL/PYTHON_SERVICE_API_KEY only ever exist here.
 *
 * The Python service rate-limits to 1 manual sync per user per minute
 * (Redis-backed) and returns 429 if this user already triggered one —
 * relayed as-is rather than re-implementing the same limit here.
 */
export async function POST() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const serviceUrl = process.env.PYTHON_SERVICE_URL;
  const serviceKey = process.env.PYTHON_SERVICE_API_KEY;

  if (!serviceUrl || !serviceKey) {
    console.error('[brokers/sync] PYTHON_SERVICE_URL or PYTHON_SERVICE_API_KEY is not set.');
    return apiError('INTERNAL_ERROR', 'Sync service is not configured.');
  }

  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/sync/${authData.user.id}`, {
      method: 'POST',
      headers: { 'x-api-key': serviceKey },
      // The service syncs every connection synchronously before responding
      // — give it real time rather than a short default fetch timeout.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error('[brokers/sync] Could not reach the sync service:', err);
    return apiError('BROKER_SYNC_ERROR', 'Could not reach the sync service. Please try again.');
  }

  if (response.status === 429) {
    return apiError('RATE_LIMITED', "You just synced — try again shortly.");
  }

  if (response.status === 404) {
    return apiError('NOT_FOUND', 'No broker connections found to sync.');
  }

  if (!response.ok) {
    console.error('[brokers/sync] Sync service returned', response.status);
    return apiError('BROKER_SYNC_ERROR', 'Sync failed. Please try again.');
  }

  const body = (await response.json().catch(() => null)) as { connections?: number } | null;

  return apiSuccess({ synced: true, connections: body?.connections ?? 0 });
}
