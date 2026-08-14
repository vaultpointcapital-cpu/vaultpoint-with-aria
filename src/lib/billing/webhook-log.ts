import { createServiceClient } from '@/lib/supabase/server';

export type WebhookClaimResult =
  | { shouldProcess: true; eventRowId: string }
  | { shouldProcess: false };

/**
 * Claims a webhook event for processing, or reports that it's a true
 * duplicate of an already-COMPLETED delivery.
 *
 * Idempotency is enforced by the DB, not by a separate select-then-insert
 * check — that pattern has a race window if the same event arrives twice
 * in quick succession (real retry behavior from both Stripe and
 * Paystack). The (provider, event_id) unique constraint on
 * billing_webhook_events is the actual backstop: this function attempts
 * the insert first and treats a unique-violation as "a row already
 * exists for this event."
 *
 * Critically, a pre-existing row only means "skip, true duplicate" if
 * that row's status is 'completed'. If the prior attempt never finished
 * (status still 'processing', or explicitly 'failed' — see
 * 20260724000002_fix_webhook_idempotency_on_partial_failure.sql for the
 * failure mode this closes: a transient error mid-processing used to
 * cause the event to be permanently swallowed on retry), this reclaims
 * it by flipping that row back to 'processing' and returns
 * shouldProcess: true, so a retry after a transient failure actually
 * reprocesses instead of silently no-oping.
 */
export async function claimWebhookEventForProcessing(params: {
  provider: 'stripe' | 'paystack' | 'flutterwave' | 'web3';
  eventId: string;
  eventType: string;
  metadata: Record<string, unknown>;
}): Promise<WebhookClaimResult> {
  const supabase = createServiceClient();

  const { data: inserted, error: insertError } = await supabase
    .from('billing_webhook_events')
    .insert({
      provider: params.provider,
      event_id: params.eventId,
      event_type: params.eventType,
      metadata: params.metadata,
    })
    .select('id')
    .single();

  if (!insertError) {
    return { shouldProcess: true, eventRowId: inserted.id };
  }

  if (insertError.code !== '23505') {
    throw new Error(`Failed to record webhook event: ${insertError.message}`);
  }

  // Row already exists for this (provider, event_id) — only a true
  // duplicate (skip) if that prior attempt actually completed.
  const { data: existing, error: selectError } = await supabase
    .from('billing_webhook_events')
    .select('id, status')
    .eq('provider', params.provider)
    .eq('event_id', params.eventId)
    .single();

  if (selectError) {
    throw new Error(`Failed to look up existing webhook event: ${selectError.message}`);
  }

  if (existing.status === 'completed') {
    return { shouldProcess: false };
  }

  // Prior attempt never finished — reclaim it for this attempt rather
  // than silently dropping the event.
  const { error: reclaimError } = await supabase
    .from('billing_webhook_events')
    .update({ status: 'processing' })
    .eq('id', existing.id);
  if (reclaimError) {
    throw new Error(`Failed to reclaim webhook event: ${reclaimError.message}`);
  }

  return { shouldProcess: true, eventRowId: existing.id };
}

export async function markWebhookEventCompleted(eventRowId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('billing_webhook_events')
    .update({ status: 'completed' })
    .eq('id', eventRowId);
  if (error) throw new Error(`Failed to mark webhook event completed: ${error.message}`);
}

export async function markWebhookEventFailed(eventRowId: string): Promise<void> {
  const supabase = createServiceClient();
  // Best-effort — if even this fails, the row is left in 'processing',
  // which claimWebhookEventForProcessing already treats as retry-worthy,
  // so a failure here doesn't reopen the swallowed-event bug this file
  // exists to fix.
  await supabase.from('billing_webhook_events').update({ status: 'failed' }).eq('id', eventRowId);
}
