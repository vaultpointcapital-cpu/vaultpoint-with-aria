import { type NextRequest, NextResponse } from 'next/server';
import { verifyVerifyMeSignature, parseVerifyMePayload, decisionFromVerifyMeStatus } from '@/lib/kyc/verifyme';
import { claimKycWebhookEventForProcessing, markKycWebhookEventCompleted, markKycWebhookEventFailed } from '@/lib/kyc/webhook-log';
import { applyKycDecision } from '@/lib/kyc/verification-state';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/webhooks/kyc/verifyme
 *
 * World B (docs/managed-accounts/03-kyc-verification.md) — same caveats
 * as the Onfido route's header comment. Additionally: VerifyMe's webhook
 * signing mechanism itself is unconfirmed (see src/lib/kyc/verifyme.ts) —
 * do not point a real VerifyMe webhook at this route until that's
 * verified against their current docs or a real test delivery.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-verifyme-signature');

  if (!verifyVerifyMeSignature(signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const payload = parseVerifyMePayload(rawBody);
  const vendorRef = payload.reference;

  const claim = await claimKycWebhookEventForProcessing({
    vendor: 'verifyme',
    eventId: vendorRef,
    eventType: 'verification.decided',
    normalizedPayload: { vendorRef, status: payload.status },
  });
  if (!claim.shouldProcess) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const supabase = createServiceClient();
    const { data: existing } = await supabase
      .from('kyc_verifications')
      .select('user_id, managed_account_id')
      .eq('vendor', 'verifyme')
      .eq('vendor_ref', vendorRef)
      .maybeSingle();

    if (!existing) {
      await markKycWebhookEventCompleted(claim.eventRowId);
      return NextResponse.json({ received: true, unmatched: true });
    }

    await applyKycDecision({
      vendor: 'verifyme',
      vendorRef,
      userId: existing.user_id,
      managedAccountId: existing.managed_account_id,
      decision: decisionFromVerifyMeStatus(payload.status),
      resultSummary: { status: payload.status },
    });
  } catch (err) {
    console.error('VerifyMe KYC webhook processing error:', err instanceof Error ? err.message : err);
    await markKycWebhookEventFailed(claim.eventRowId);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  await markKycWebhookEventCompleted(claim.eventRowId);
  return NextResponse.json({ received: true });
}
