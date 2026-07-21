import { createServiceClient } from '@/lib/supabase/server';

/**
 * Records a webhook event and reports whether it's new. Idempotency is
 * enforced by the DB, not by a separate select-then-insert check — that
 * pattern has a race window if the same event arrives twice in quick
 * succession (real retry behavior from both Stripe and Paystack). The
 * (provider, event_id) unique constraint on billing_webhook_events (see
 * supabase/migrations/20260717000000_reconcile_subscriptions_for_billing.sql)
 * is the actual backstop: this function attempts the insert first and
 * treats a unique-violation as "already processed", atomically.
 */
export async function recordWebhookEventIfNew(params: {
  provider: 'stripe' | 'paystack' | 'flutterwave';
  eventId: string;
  eventType: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const supabase = createServiceClient();

  const { error } = await supabase.from('billing_webhook_events').insert({
    provider: params.provider,
    event_id: params.eventId,
    event_type: params.eventType,
    metadata: params.metadata,
  });

  if (error) {
    if (error.code === '23505') {
      return false;
    }
    throw new Error(`Failed to record webhook event: ${error.message}`);
  }
  return true;
}
