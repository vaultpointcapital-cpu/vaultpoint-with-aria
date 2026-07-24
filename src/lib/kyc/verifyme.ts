import crypto from 'crypto';
import type { KycVerificationState } from '@/types/database';

/**
 * VerifyMe Nigeria's webhook-signing mechanism is NOT confirmed — spec
 * §7 flags this explicitly: "VerifyMe's mechanism must be confirmed
 * against current docs — if it lacks signed webhooks, fall back to
 * authenticated server-side polling, do not trust an unsigned callback."
 * This implements the most conservative reasonable default (a static
 * shared-secret header comparison, mirroring Flutterwave's verif-hash
 * scheme) so the endpoint exists and is testable, but it must NOT be
 * trusted for a real verification decision until confirmed against
 * VerifyMe's current docs or a real test delivery from their dashboard.
 * If VerifyMe turns out to have no signed-webhook option at all, this
 * function should be replaced with the polling fallback the spec
 * describes, not loosened.
 */
export function verifyVerifyMeSignature(signatureHeader: string | null): boolean {
  const sharedSecret = process.env.VERIFYME_WEBHOOK_SECRET;
  if (!sharedSecret || !signatureHeader) return false;

  const expectedBuffer = Buffer.from(sharedSecret, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Pattern, not contract (spec §2) — VerifyMe's actual webhook payload
 * shape must be confirmed against their current docs before this is
 * relied on. Modeled on their documented BVN/NIN verification response
 * shape (a top-level status plus a nested verification object), not a
 * confirmed webhook delivery.
 */
interface VerifyMeWebhookPayload {
  status: string; // e.g. 'success' | 'failed' | 'pending'
  reference: string; // vendor_ref — the id we'd have stored on kyc_verifications
  data?: {
    verification?: { status?: string };
  };
}

export function parseVerifyMePayload(rawBody: string): VerifyMeWebhookPayload {
  return JSON.parse(rawBody) as VerifyMeWebhookPayload;
}

export function decisionFromVerifyMeStatus(status: string): KycVerificationState {
  if (status === 'success') return 'verified';
  if (status === 'failed') return 'rejected';
  return 'processing';
}
