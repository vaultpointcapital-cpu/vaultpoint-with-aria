import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { executeSignalSchema } from '@/lib/validations/signals';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/signals/:id/execute
 *
 * Server-side proxy to the Python broker-sync service's
 * POST /signals/{signal_id}/execute — same trust boundary as
 * /api/brokers/sync: PYTHON_SERVICE_URL/PYTHON_SERVICE_API_KEY only ever
 * exist here, the browser never calls that service directly.
 *
 * The Python service is the one that inserts the signal_actions row on
 * BOTH outcomes (executed or failed) — this route does not duplicate
 * that insert, only relays the result. See
 * services/broker-sync/app/main.py's execute_signal_endpoint and
 * signal_execution.py.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = executeSignalSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid execution request.', parsed.error.flatten());
  }

  const serviceUrl = process.env.PYTHON_SERVICE_URL;
  const serviceKey = process.env.PYTHON_SERVICE_API_KEY;

  if (!serviceUrl || !serviceKey) {
    console.error('[signals/execute] PYTHON_SERVICE_URL or PYTHON_SERVICE_API_KEY is not set.');
    return apiError('INTERNAL_ERROR', 'Signal execution is not configured.');
  }

  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/signals/${params.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': serviceKey },
      body: JSON.stringify({
        user_id: authData.user.id,
        broker_connection_id: parsed.data.brokerConnectionId,
        size: parsed.data.size,
      }),
      // Placing a real order round-trips to the broker itself — give it
      // real time rather than a short default fetch timeout.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error('[signals/execute] Could not reach the execution service:', err);
    return apiError('BROKER_SYNC_ERROR', 'Could not reach the execution service. Please try again.');
  }

  if (response.status === 422) {
    // The Python service's own error shape is FastAPI's default
    // { detail: "..." }, not this app's { error, code, details } — the
    // detail IS the human-readable reason (broker rejection, connection
    // not authorized, etc.), safe to relay directly to the user.
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    return apiError('VALIDATION_ERROR', body?.detail ?? 'Could not execute this signal.');
  }

  if (!response.ok) {
    console.error('[signals/execute] Execution service returned', response.status);
    return apiError('BROKER_SYNC_ERROR', 'Execution failed. Please try again.');
  }

  const result = (await response.json()) as {
    status: string;
    broker_order_id: string;
    signal_action_id: string;
  };

  return apiSuccess({
    status: result.status,
    brokerOrderId: result.broker_order_id,
    signalActionId: result.signal_action_id,
  });
}
