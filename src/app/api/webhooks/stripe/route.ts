import { type NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { getStripeClient, tierFromStripePriceId } from '@/lib/billing/stripe';
import { syncUserSubscriptionTier } from '@/lib/billing/get-user-tier';
import { claimWebhookEventForProcessing, markWebhookEventCompleted, markWebhookEventFailed } from '@/lib/billing/webhook-log';
import { applyValueLedgerEvent } from '@/lib/value-ledger/events';
import { snapshotTierContractOnRenewal } from '@/lib/tier-contracts/snapshot';

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

  const claim = await claimWebhookEventForProcessing({
    provider: 'stripe',
    eventId: event.id,
    eventType: event.type,
    metadata: { objectId: (event.data.object as { id?: string }).id ?? null },
  });
  if (!claim.shouldProcess) {
    // Same event id retried, and the prior attempt already completed —
    // ack without reprocessing. (A retry of an attempt that never
    // finished is NOT treated as a duplicate — see claimWebhookEventForProcessing.)
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
          past_due_since: null,
        });
        if (insertError) throw insertError;
        await syncUserSubscriptionTier(supabase, userId);
        // Tier Contract — snapshots which tier_contract version was active
        // at this signup, never "whatever's active today".
        await snapshotTierContractOnRenewal(supabase, userId, tier ?? 'pro');
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const item = subscription.items.data[0];
        const tier = item ? tierFromStripePriceId(item.price.id) : null;
        const newStatus = mapStripeStatus(subscription.status);

        const { data: updated, error } = await supabase
          .from('subscriptions')
          .update({
            status: newStatus,
            current_period_end: item ? toIsoString(item.current_period_end) : null,
            ...(tier ? { tier } : {}),
            // Recovery (back to active/trialing) clears the grace-period
            // clock. Entering/staying past_due via this event is left
            // alone here — invoice.payment_failed is the authoritative
            // signal for starting the clock, so it isn't reset by every
            // unrelated customer.subscription.updated delivery.
            ...(newStatus === 'active' || newStatus === 'trialing' ? { past_due_since: null } : {}),
          })
          .eq('provider_subscription_id', subscription.id)
          .select('user_id, tier');
        if (error) throw error;

        for (const row of updated ?? []) {
          await syncUserSubscriptionTier(supabase, row.user_id);
          // Only on the same real-activation condition already used above
          // (active/trialing) — never on a status that isn't a real renewal.
          if (newStatus === 'active' || newStatus === 'trialing') {
            await snapshotTierContractOnRenewal(supabase, row.user_id, row.tier);
          }
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

      case 'payment_intent.succeeded': {
        // Wallet deposits use a raw PaymentIntent (createDepositPaymentIntent
        // in src/lib/billing/stripe.ts), not a subscription Checkout Session
        // — this event type is otherwise unhandled in this webhook, so
        // there's no collision with the subscription cases above.
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const userId = paymentIntent.metadata?.user_id;
        if (!userId || paymentIntent.metadata?.purpose !== 'wallet_deposit') break;

        const { error } = await supabase.rpc('wallet_apply_transaction', {
          p_user_id: userId,
          p_type: 'deposit',
          p_amount: paymentIntent.amount / 100,
          p_currency: paymentIntent.currency.toUpperCase(),
          p_provider: 'stripe',
          p_provider_reference: paymentIntent.id,
          p_idempotency_key: paymentIntent.id,
          p_metadata: {},
        });
        if (error) throw error;
        // Value Ledger — feeds time_to_first_value_days. Reuses the
        // wallet transaction's own idempotency key, so a replayed webhook
        // delivery naturally no-ops here too.
        await applyValueLedgerEvent(supabase, {
          userId,
          eventName: 'wallet_deposit',
          idempotencyKey: `wallet_deposit:${paymentIntent.id}`,
          properties: { provider: 'stripe', currency: paymentIntent.currency.toUpperCase() },
          source: 'wallet',
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionRef = invoice.parent?.subscription_details?.subscription;
        const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : subscriptionRef?.id;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

        // Select first (not a blind update) so past_due_since is only set
        // the FIRST time a row enters past_due — a retried/second decline
        // for the same outage must not push the grace-period clock forward.
        const selectResult = subscriptionId
          ? await supabase.from('subscriptions').select('id, user_id, status').eq('provider_subscription_id', subscriptionId)
          : customerId
            ? await supabase.from('subscriptions').select('id, user_id, status').eq('provider_customer_id', customerId)
            : { data: [], error: null };
        if (selectResult.error) throw selectResult.error;

        for (const row of selectResult.data ?? []) {
          const { error } = await supabase
            .from('subscriptions')
            .update({
              status: 'past_due',
              ...(row.status !== 'past_due' ? { past_due_since: new Date().toISOString() } : {}),
            })
            .eq('id', row.id);
          if (error) throw error;
          await syncUserSubscriptionTier(supabase, row.user_id);
          // Value Ledger — feeds churn_risk_score's "declined/failed
          // payment" signal. Keyed to this webhook delivery + row, not
          // date-scoped like tier_changed, since each decline is its own
          // distinct event even within the same day.
          await applyValueLedgerEvent(supabase, {
            userId: row.user_id,
            eventName: 'payment_failed',
            idempotencyKey: `payment_failed:${claim.eventRowId}:${row.id}`,
            properties: { provider: 'stripe' },
            source: 'billing_webhook',
          });
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
    await markWebhookEventFailed(claim.eventRowId);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  await markWebhookEventCompleted(claim.eventRowId);
  return NextResponse.json({ received: true });
}
