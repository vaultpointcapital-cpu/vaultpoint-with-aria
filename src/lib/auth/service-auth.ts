import crypto from 'crypto';
import { type NextRequest } from 'next/server';

/**
 * Verifies the x-api-key header against PYTHON_SERVICE_API_KEY — the same
 * shared secret already sent Next.js -> Python for the opposite direction
 * (src/app/api/signals/[id]/execute/route.ts, src/app/api/brokers/sync/route.ts),
 * reused rather than minting a second one. Mirrors
 * services/broker-sync/app/main.py's require_api_key/_constant_time_eq
 * exactly: constant-time compare, not ===, since this guards a real secret
 * and is the only thing standing between the public internet and driving
 * this route for an arbitrary userId.
 *
 * This is the first Python -> Next.js call in the codebase
 * (services/broker-sync/app/decision_gate/step_up_client.py) — every
 * existing cross-service call goes the other direction, so nothing
 * verified this header inbound before now.
 */
export function requireServiceApiKey(request: NextRequest): boolean {
  const expected = process.env.PYTHON_SERVICE_API_KEY;
  const provided = request.headers.get('x-api-key');
  if (!expected || !provided) return false;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}
