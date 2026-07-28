import { type NextRequest, NextResponse } from 'next/server';
import { verifyOnfidoSignature, parseOnfidoPayload, decisionFromOnfidoAction } from '@/lib/kyc/onfido';
import { claimKycWebhookEventForProcessing, markKycWebhookEventCompleted, markKycWebhookEventFailed } from '@/lib/kyc/webhook-log';
import { applyKycDecision } from '@/lib/kyc/verification-state';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/webhooks/kyc/onfido
 *
 * World B (docs/managed-accounts/03-kyc-verification.md) — this route is
 * buildable and testable now without touching real client PII, since
 * nothing upstream of it (the onboarding wizard's KYC step) is wired to
 * actually launch Onfido's real capture flow yet. See the spec's World
 * A / World B split before treating this as launch-ready.
 *
 * NOT YET VERIFIED against a real Onfido webhook delivery — see
 * src/lib/kyc/onfido.ts's comments on the signature scheme and payload
 * shape. Send a real test event from the Onfido dashboard before relying
 * on this in production.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-sha2-signature');

  if (!verifyOnfidoSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const payload = parseOnfidoPayload(rawBody);
  const vendorRef = payload.payload.object.id;

  const claim = await claimKycWebhookEventForProcessing({
    vendor: 'onfido',
    eventId: `${vendorRef}:${payload.payload.action}`,
    eventType: payload.payload.action,
    normalizedPayload: { vendorRef, action: payload.payload.action, status: payload.payload.object.status },
  });
  if (!claim.shouldProcess) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const supabase = createServiceClient();
    const { data: existing } = await supabase
      .from('kyc_verifications')
      .select('user_id, managed_account_id')
      .eq('vendor', 'onfido')
      .eq('vendor_ref', vendorRef)
      .maybeSingle();

    if (!existing) {
      // No row was ever created for this vendor_ref via
      // getOrCreateKycVerificationRow — can't attribute this delivery to
      // a user/account. Logged to kyc_webhook_events regardless (the
      // append-only audit trail), but there's nothing to apply.
      await markKycWebhookEventCompleted(claim.eventRowId);
      return NextResponse.json({ received: true, unmatched: true });
    }

    await applyKycDecision({
      vendor: 'onfido',
      vendorRef,
      userId: existing.user_id,
      managedAccountId: existing.managed_account_id,
      decision: decisionFromOnfidoAction(payload.payload.action),
      resultSummary: { action: payload.payload.action, status: payload.payload.object.status },
    });
  } catch (err) {
    console.error('Onfido KYC webhook processing error:', err instanceof Error ? err.message : err);
    await markKycWebhookEventFailed(claim.eventRowId);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  await markKycWebhookEventCompleted(claim.eventRowId);
  return NextResponse.json({ received: true });
}
