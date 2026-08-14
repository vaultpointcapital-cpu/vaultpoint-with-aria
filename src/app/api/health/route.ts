import { createServiceClient } from '@/lib/supabase/server';
import { redis } from '@/lib/redis';

/**
 * GET /api/health
 * Mirrors the Python broker-sync service's own /health (checks DB +
 * Redis, returns commit SHA, 503 on any check failing) rather than the
 * previous bare "status: ok" — see services/broker-sync/app/main.py's
 * health() for the sibling implementation this is deliberately
 * consistent with.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) throw error;
    checks.database = 'ok';
  } catch (err) {
    checks.database = `error: ${err instanceof Error ? err.message : String(err)}`;
    healthy = false;
  }

  if (redis) {
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = `error: ${err instanceof Error ? err.message : String(err)}`;
      healthy = false;
    }
  } else {
    // Not configured, not failing — same distinction lib/redis.ts and
    // lib/rate-limit.ts already make (missing config isn't the same
    // failure mode as an unreachable, otherwise-configured Redis).
    checks.redis = 'not configured';
  }

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      // Vercel sets this automatically for every deploy — not present
      // running locally, hence the fallback rather than a hard
      // requirement.
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
      checks,
    },
    { status: healthy ? 200 : 503 }
  );
}
