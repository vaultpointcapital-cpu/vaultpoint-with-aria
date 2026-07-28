import { type NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { verifyFlutterwaveSignature, tierFromFlutterwavePlanId } from '@/lib/billing/flutterwave';
import { syncUserSubscriptionTier } from '@/lib/billing/get-user-tier';
import { claimWebhookEventForProcessing, markWebhookEventCompleted, markWebhookEventFailed } from '@/lib/billing/webhook-log';

/**
 * NOT YET VERIFIED against a real webhook delivery from Flutterwave —
 * built from the documented `charge.completed` example payload plus
 * empirical testing of POST /v3/payment-plans and /v3/payments against
 * the real test-mode API (both confirmed working). The exact field names
 * below (event name, data.customer shape, data.payment_plan) are the
 * best-documented/most-standard interpretation, not confirmed against a
 * live delivery. Before relying on this in production: send a real test
 * webhook from the Flutterwave dashboard (or complete one real test
 * checkout) and diff the actual payload against what's read here.
 *
 * Flutterwave's recurring-payment model is simpler than Stripe/Paystack's:
 * every charge (first subscribe AND every renewal) fires the same
 * charge.completed event referencing the same payment_plan — there is no
 * separate "subscription created/updated/cancelled" webhook lifecycle to
 * handle. A failed renewal is the same event with status: 'failed'.
 * Cancellation isn't pushed via webhook at all in the basic model; it
 * would need a dedicated cancel flow calling Flutterwave's own
 * cancel-subscription API, which doesn't exist yet in this app for any
 * processor (Stripe/Paystack cancellation is also handled entirely
 * outside the app today).
 */
interface FlutterwaveWebhookPayload {
  event: string;
  data: {
    id?: number;
    tx_ref?: string;
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer?: { id?: number; email?: string };
    payment_plan?: number | string;
    plan?: { id?: number | string } | null;
    meta?: { user_id?: string };
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('verif-hash');

  if (!verifyFlutterwaveSignature(signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const payload = JSON.parse(rawBody) as FlutterwaveWebhookPayload;

  // Flutterwave doesn't sign the body (verif-hash is a static shared
  // secret, not a per-payload HMAC), so unlike Stripe/Paystack the
  // signature itself can't serve as an idempotency key — data.id (the
  // transaction id) is the best per-delivery fingerprint available.
  const claim = await claimWebhookEventForProcessing({
    provider: 'flutterwave',
    eventId: String(payload.data.id ?? payload.data.tx_ref ?? payload.data.reference ?? ''),
    eventType: payload.event,
    metadata: { txRef: payload.data.tx_ref ?? payload.data.reference ?? null },
  });
  if (!claim.shouldProcess) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const supabase = createServiceClient();

  try {
    switch (payload.event) {
      case 'charge.completed': {
        const userId = payload.data.meta?.user_id;
        const customerEmail = payload.data.customer?.email;
        if (!userId) break;

        const planId = payload.data.payment_plan ?? payload.data.plan?.id;
        const tier = tierFromFlutterwavePlanId(planId);
        const succeeded = payload.data.status === 'successful';

        const { data: existing, error: selectError } = customerEmail
          ? await supabase
              .from('subscriptions')
              .select('id, status')
              .eq('payment_provider', 'flutterwave')
              .eq('provider_customer_id', customerEmail)
              .maybeSingle()
          : { data: null, error: null };
        if (selectError) throw selectError;

        if (existing) {
          const { error } = await supabase
            .from('subscriptions')
            .update({
              status: succeeded ? 'active' : 'past_due',
              ...(tier ? { tier } : {}),
              ...(succeeded ? { past_due_since: null } : existing.status !== 'past_due' ? { past_due_since: new Date().toISOString() } : {}),
            })
            .eq('id', existing.id);
          if (error) throw error;
        } else if (succeeded) {
          // Only ever insert on a SUCCESSFUL first charge — a failed
          // first attempt with no prior row means the user never had
          // access to begin with, nothing to revoke, and no row to
          // create (mirrors Stripe/Paystack: a declined checkout never
          // reaches our webhook as a state to persist).
          const { error } = await supabase.from('subscriptions').upsert(
            {
              user_id: userId,
              payment_provider: 'flutterwave',
              provider_subscription_id: payload.data.tx_ref ?? payload.data.reference ?? null,
              provider_customer_id: customerEmail ?? null,
              tier: tier ?? 'pro',
              status: 'active',
              current_period_end: null,
              past_due_since: null,
            },
            { onConflict: 'payment_provider,provider_customer_id' }
          );
          if (error) throw error;
        }

        await syncUserSubscriptionTier(supabase, userId);
        break;
      }

      default:
        // Unhandled event type — already logged to billing_webhook_events
        // above, nothing further to do.
        break;
    }
  } catch (err) {
    console.error('Flutterwave webhook processing error:', err instanceof Error ? err.message : err);
    await markWebhookEventFailed(claim.eventRowId);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  await markWebhookEventCompleted(claim.eventRowId);
  return NextResponse.json({ received: true });
}
