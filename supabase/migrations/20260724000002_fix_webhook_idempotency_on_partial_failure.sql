-- ============================================================================
-- VaultPoint — fix webhook idempotency swallowing failed deliveries
-- ============================================================================
-- Week 3 Thursday finding (webhook reliability check): recordWebhookEventIfNew
-- (src/lib/billing/webhook-log.ts) inserts a billing_webhook_events row
-- BEFORE the webhook's actual processing (subscription upsert, tier sync)
-- runs, then returns isNew=false (treated as "already handled, ack and
-- skip") purely based on whether a row for this (provider, event_id)
-- already exists -- with no regard for whether that FIRST attempt ever
-- actually finished successfully.
--
-- Failure mode this causes: processing throws partway through (a
-- transient DB error, a Supabase blip, anything) AFTER the event row was
-- already inserted. The route correctly returns 500, so Stripe/Paystack
-- correctly retry the SAME event id -- but the retry's own
-- recordWebhookEventIfNew call now sees the row already exists (from the
-- FAILED first attempt), reports isNew=false, and the route acks with
-- 200 "duplicate" WITHOUT ever applying the update. The processor sees
-- 200 and stops retrying. The event is now permanently, silently lost --
-- a user could pay successfully and never get their tier synced, with no
-- automatic recovery.
--
-- Fix: track completion, not just receipt. A retry is only treated as a
-- true duplicate (skip, ack 200) if the prior attempt's row has
-- status='completed'. Anything else (still 'processing', or explicitly
-- 'failed') means the prior attempt never finished, so the retry must be
-- allowed to actually reprocess.
-- ============================================================================

alter table public.billing_webhook_events
  add column status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed'));

comment on column public.billing_webhook_events.status is
  'processing = row inserted, handler has not finished yet. completed = handler ran successfully; a redelivery of this event_id is a true duplicate, skip it. failed = handler threw; a redelivery must be allowed to reprocess, not skipped. See this migration''s header for the failure mode this closes.';
