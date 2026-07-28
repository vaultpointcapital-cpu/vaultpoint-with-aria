import { createServiceClient } from '@/lib/supabase/server';
import type { KycVendor } from '@/types/database';

export type KycWebhookClaimResult =
  | { shouldProcess: true; eventRowId: string }
  | { shouldProcess: false };

/**
 * Same claim/reclaim idempotency pattern as
 * claimWebhookEventForProcessing (src/lib/billing/webhook-log.ts): insert
 * first, treat a unique-violation on (vendor, event_id) as "a row already
 * exists," and only actually skip if that prior attempt's status is
 * 'completed'. A retry after a failed or still-processing prior attempt
 * is reclaimed, not silently dropped — same reasoning as the billing
 * webhook fix (20260724000002), applied here from the start rather than
 * as a later patch.
 */
export async function claimKycWebhookEventForProcessing(params: {
  vendor: KycVendor;
  eventId: string;
  eventType: string;
  normalizedPayload: Record<string, unknown>;
}): Promise<KycWebhookClaimResult> {
  const supabase = createServiceClient();

  const { data: inserted, error: insertError } = await supabase
    .from('kyc_webhook_events')
    .insert({
      vendor: params.vendor,
      event_id: params.eventId,
      event_type: params.eventType,
      normalized_payload: params.normalizedPayload,
    })
    .select('id')
    .single();

  if (!insertError) {
    return { shouldProcess: true, eventRowId: inserted.id };
  }

  if (insertError.code !== '23505') {
    throw new Error(`Failed to record KYC webhook event: ${insertError.message}`);
  }

  const { data: existing, error: selectError } = await supabase
    .from('kyc_webhook_events')
    .select('id, status')
    .eq('vendor', params.vendor)
    .eq('event_id', params.eventId)
    .single();

  if (selectError) {
    throw new Error(`Failed to look up existing KYC webhook event: ${selectError.message}`);
  }

  if (existing.status === 'completed') {
    return { shouldProcess: false };
  }

  const { error: reclaimError } = await supabase
    .from('kyc_webhook_events')
    .update({ status: 'processing' })
    .eq('id', existing.id);
  if (reclaimError) {
    throw new Error(`Failed to reclaim KYC webhook event: ${reclaimError.message}`);
  }

  return { shouldProcess: true, eventRowId: existing.id };
}

export async function markKycWebhookEventCompleted(eventRowId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from('kyc_webhook_events')
    .update({ status: 'completed' })
    .eq('id', eventRowId);
  if (error) throw new Error(`Failed to mark KYC webhook event completed: ${error.message}`);
}

export async function markKycWebhookEventFailed(eventRowId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from('kyc_webhook_events').update({ status: 'failed' }).eq('id', eventRowId);
}
