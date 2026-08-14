import crypto from 'crypto';
import type { KycVerificationState } from '@/types/database';

/**
 * Onfido signs webhook deliveries with an HMAC-SHA256 of the raw request
 * body, keyed by the webhook token configured in the Onfido dashboard,
 * sent as the `X-SHA2-Signature` header (hex digest). This matches
 * Onfido's documented webhook-signing scheme as of when this was
 * written — per this spec's own §2 warning, confirm against Onfido's
 * current docs before trusting this in production; NOT yet verified
 * against a real webhook delivery (Onfido's dashboard has a
 * send-test-event feature — use it before going live).
 */
export function verifyOnfidoSignature(rawBody: string, signatureHeader: string | null): boolean {
  const webhookToken = process.env.ONFIDO_WEBHOOK_TOKEN;
  if (!webhookToken || !signatureHeader) return false;

  const expected = crypto.createHmac('sha256', webhookToken).update(rawBody, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Onfido's check.completed webhook payload shape — pattern, not
 * contract (spec §2). The exact field names (result vs. status, the
 * breakdown structure) must be confirmed against a real delivery before
 * this is relied on; this is the best-documented/most-standard reading
 * available without live access to Onfido's current API docs.
 */
interface OnfidoWebhookPayload {
  payload: {
    resource_type: string;
    action: string;
    object: {
      id: string;
      status: string; // e.g. 'complete'
      completed_at_iso8601?: string;
      href?: string;
    };
  };
}

export function parseOnfidoPayload(rawBody: string): OnfidoWebhookPayload {
  return JSON.parse(rawBody) as OnfidoWebhookPayload;
}

/**
 * Onfido reports a check `result` (clear / consider) via a separate
 * GET /checks/:id call in the standard integration pattern, since the
 * webhook itself often only signals "the check completed," not the
 * verdict — the spec text describes this ambiguity too ("must be
 * confirmed against current docs"). Until that retrieval call is built
 * (needs a confirmed Onfido API client, out of scope for this pass —
 * see docs/managed-accounts/03-kyc-verification.md open decisions),
 * this treats a 'complete' webhook action as provisionally 'processing'
 * rather than guessing at pass/fail from the webhook alone. Wire this up
 * to a real GET /checks/:id call before relying on it.
 */
export function decisionFromOnfidoAction(action: string): KycVerificationState {
  if (action === 'check.completed') return 'processing';
  return 'error';
}
