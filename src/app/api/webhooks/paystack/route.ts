import { type NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { verifyPaystackSignature, tierFromPaystackPlanCode } from '@/lib/billing/paystack';
import { recordWebhookEventIfNew } from '@/lib/billing/webhook-log';

// Same as the Stripe route: App Router route handlers never auto-parse
// the body, so request.text() below is already the raw bytes Paystack
// signed — no bodyParser config needed.

interface PaystackWebhookPayload {
  event: string;
  data: {
    id?: number;
    status?: string;
    customer?: { customer_code?: string; email?: string };
    plan?: { plan_code?: string } | null;
    subscription_code?: string;
    subscription?: { subscription_code?: string } | null;
    metadata?: { user_id?: string };
    next_payment_date?: string;
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  let valid: boolean;
  try {
    valid = verifyPaystackSignature(rawBody, signature);
  } catch (err) {
    console.error('Paystack signature verification error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const payload = JSON.parse(rawBody) as PaystackWebhookPayload;

  // Paystack, unlike Stripe, doesn't include a single stable top-level
  // event id across every event type (data.id is only meaningful for
  // charge events). The signature itself is an HMAC over the exact raw
  // body, so it's already a reliable per-delivery fingerprint — using it
  // as the idempotency key catches exact-duplicate retries the same way
  // a real event id would.
  const isNew = await recordWebhookEventIfNew({
    provider: 'paystack',
    eventId: signature as string,
    eventType: payload.event,
    metadata: { subscriptionCode: payload.data.subscription_code ?? payload.data.subscription?.subscription_code ?? null },
  });
  if (!isNew) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const supabase = createServiceClient();

  try {
    switch (payload.event) {
      case 'charge.success': {
        const userId = payload.data.metadata?.user_id;
        const customerCode = payload.data.customer?.customer_code;
        if (!userId) break;

        const tier = tierFromPaystackPlanCode(payload.data.plan?.plan_code);

        // A renewal charge on an existing subscription vs. the very first
        // charge both fire charge.success — update in place if we already
        // have a row for this customer, otherwise this is the initial
        // checkout and we insert.
        const { data: existing } = customerCode
          ? await supabase.from('subscriptions').select('id').eq('provider_customer_id', customerCode).maybeSingle()
          : { data: null };

        if (existing) {
          await supabase
            .from('subscriptions')
            .update({ status: 'active', ...(tier ? { tier } : {}) })
            .eq('id', existing.id);
        } else {
          await supabase.from('subscriptions').insert({
            user_id: userId,
            payment_provider: 'paystack',
            provider_subscription_id: null,
            provider_customer_id: customerCode ?? null,
            tier: tier ?? 'pro',
            status: 'active',
            current_period_end: null,
          });
        }
        break;
      }

      case 'subscription.create': {
        const customerCode = payload.data.customer?.customer_code;
        const subscriptionCode = payload.data.subscription_code;
        if (!customerCode || !subscriptionCode) break;

        await supabase
          .from('subscriptions')
          .update({
            provider_subscription_id: subscriptionCode,
            status: 'active',
            current_period_end: payload.data.next_payment_date ?? null,
          })
          .eq('provider_customer_id', customerCode);
        break;
      }

      case 'subscription.disable': {
        const subscriptionCode = payload.data.subscription_code;
        if (!subscriptionCode) break;

        await supabase.from('subscriptions').update({ status: 'cancelled' }).eq('provider_subscription_id', subscriptionCode);
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionCode = payload.data.subscription?.subscription_code;
        const customerCode = payload.data.customer?.customer_code;

        if (subscriptionCode) {
          await supabase.from('subscriptions').update({ status: 'past_due' }).eq('provider_subscription_id', subscriptionCode);
        } else if (customerCode) {
          await supabase.from('subscriptions').update({ status: 'past_due' }).eq('provider_customer_id', customerCode);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('Paystack webhook processing error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
