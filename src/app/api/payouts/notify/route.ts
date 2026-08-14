import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { requireServiceApiKey } from '@/lib/auth/service-auth';
import { sendPayoutAlert } from '@/lib/payouts/alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/payouts/notify
 *
 * Called only by services/broker-sync/app/payout_detection.py
 * (_notify_founder), x-api-key gated like every other Python <-> Next.js
 * boundary in this codebase — never reachable from a browser. Founder/ops
 * notification on every new withdrawal_event regardless of confidence
 * (spec section 3.3) — Python does the detection and DB insert, this
 * route only handles the Slack+email dispatch, since src/lib/slack/send.ts
 * and src/lib/email/send.ts are TS-only.
 */
export async function POST(request: NextRequest) {
  if (!requireServiceApiKey(request)) {
    return apiError('UNAUTHORIZED', 'Invalid or missing API key.');
  }

  const body = await request.json().catch(() => null);
  const withdrawalEventId = body?.withdrawalEventId;
  if (typeof withdrawalEventId !== 'string') {
    return apiError('VALIDATION_ERROR', 'withdrawalEventId is required.');
  }

  const admin = createServiceClient();
  const { data: event } = await admin.from('withdrawal_events').select('*').eq('id', withdrawalEventId).maybeSingle();
  if (!event) return apiError('NOT_FOUND', 'Withdrawal event not found.');

  await sendPayoutAlert({
    withdrawalEventId: event.id,
    summary: `Detected withdrawal of ${event.detected_amount} on connection ${event.broker_connection_id} (confidence: ${event.confidence}).`,
  });

  return apiSuccess({ notified: true });
}
