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
    // Only present on charge.success — the reusable code
    // /transaction/charge_authorization needs to bill this customer
    // off-session later (profit-share true-ups). Paystack re-sends the
    // same authorization on every renewal charge, not just the first.
    authorization?: { authorization_code?: string; reusable?: boolean };
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
        // Only stored when Paystack marks it reusable — a non-reusable
        // authorization_code would fail every later charge_authorization
        // call anyway, so storing it would just be a misleading no-op
        // for profit-share billing rather than a real capability.
        const authorization = payload.data.authorization;
        const authorizationCode =
          authorization?.reusable && authorization.authorization_code ? authorization.authorization_code : undefined;

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
            .update({
              status: 'active',
              ...(tier ? { tier } : {}),
              ...(authorizationCode ? { paystack_authorization_code: authorizationCode } : {}),
            })
            .eq('id', existing.id);
        } else {
          // upsert, not insert: the select above and this write aren't
          // atomic, so a concurrent charge.success delivery for the same
          // brand-new customer could land in between and also see
          // existing === null. idx_subscriptions_provider_customer_unique
          // (20260720000001_fix_subscriptions_race_and_drift.sql) makes
          // that a conflict instead of a duplicate row — onConflict
          // reconciles it the same way the "existing" branch above would,
          // rather than erroring out and losing this event.
          await supabase
            .from('subscriptions')
            .upsert(
              {
                user_id: userId,
                payment_provider: 'paystack',
                provider_subscription_id: null,
                provider_customer_id: customerCode ?? null,
                paystack_authorization_code: authorizationCode ?? null,
                tier: tier ?? 'pro',
                status: 'active',
                current_period_end: null,
              },
              { onConflict: 'payment_provider,provider_customer_id' }
            );
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
