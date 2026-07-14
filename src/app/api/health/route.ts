import { apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/health
 * Basic liveness check for Vercel/uptime monitoring. Deliberately does
 * NOT check database connectivity here — that belongs in a separate
 * readiness check if needed, since this endpoint should respond fast and
 * never fail just because Supabase is briefly slow.
 */
export async function GET() {
  return apiSuccess({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}
