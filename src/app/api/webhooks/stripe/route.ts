import { type NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { getStripeClient, tierFromStripePriceId } from '@/lib/billing/stripe';
import { syncUserSubscriptionTier } from '@/lib/billing/get-user-tier';
import { recordWebhookEventIfNew } from '@/lib/billing/webhook-log';

// Next.js App Router route handlers never auto-parse the body (unlike the
// Pages Router's api routes), so request.text() below already gives the
// raw bytes Stripe signed — no bodyParser config needed.

/** Maps Stripe's subscription status vocabulary onto ours. Stripe has
 * states we don't model separately (incomplete, unpaid, paused) — they
 * fold to 'past_due' since none of them mean "the user has working
 * access", which is what our narrower enum is actually gating. */
function mapStripeStatus(status: Stripe.Subscription.Status): 'active' | 'past_due' | 'cancelled' | 'trialing' {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'canceled':
      return 'cancelled';
    default:
      return 'past_due';
  }
}

function toIsoString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Log only the failure reason, never the raw body/signature.
    console.error('Stripe webhook signature verification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const isNew = await recordWebhookEventIfNew({
    provider: 'stripe',
    eventId: event.id,
    eventType: event.type,
    metadata: { objectId: (event.data.object as { id?: string }).id ?? null },
  });
  if (!isNew) {
    // Same event id retried — already applied, ack without reprocessing.
    return NextResponse.json({ received: true, duplicate: true });
  }

  const supabase = createServiceClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

        if (!userId || !subscriptionId) break;

        const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
        const item = subscription.items.data[0];
        const tier = item ? tierFromStripePriceId(item.price.id) : null;

        const { error: insertError } = await supabase.from('subscriptions').insert({
          user_id: userId,
          payment_provider: 'stripe',
          provider_subscription_id: subscriptionId,
          provider_customer_id: customerId ?? null,
          tier: tier ?? 'pro',
          status: mapStripeStatus(subscription.status),
          current_period_end: item ? toIsoString(item.current_period_end) : null,
        });
        if (insertError) throw insertError;
        await syncUserSubscriptionTier(supabase, userId);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const item = subscription.items.data[0];
        const tier = item ? tierFromStripePriceId(item.price.id) : null;

        const { data: updated, error } = await supabase
          .from('subscriptions')
          .update({
            status: mapStripeStatus(subscription.status),
            current_period_end: item ? toIsoString(item.current_period_end) : null,
            ...(tier ? { tier } : {}),
          })
          .eq('provider_subscription_id', subscription.id)
          .select('user_id');
        if (error) throw error;

        for (const row of updated ?? []) {
          await syncUserSubscriptionTier(supabase, row.user_id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const { data: updated, error } = await supabase
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('provider_subscription_id', subscription.id)
          .select('user_id');
        if (error) throw error;

        for (const row of updated ?? []) {
          await syncUserSubscriptionTier(supabase, row.user_id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionRef = invoice.parent?.subscription_details?.subscription;
        const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

        let updated = null;
        if (subscriptionId) {
          const result = await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('provider_subscription_id', subscriptionId)
            .select('user_id');
          if (result.error) throw result.error;
          updated = result.data;
        } else if (customerId) {
          const result = await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('provider_customer_id', customerId)
            .select('user_id');
          if (result.error) throw result.error;
          updated = result.data;
        }

        for (const row of updated ?? []) {
          await syncUserSubscriptionTier(supabase, row.user_id);
        }
        break;
      }

      default:
        // Unhandled event type — already logged to billing_webhook_events
        // above, nothing further to do.
        break;
    }
  } catch (err) {
    console.error('Stripe webhook processing error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
