-- ============================================================================
-- VaultPoint — allow 'flutterwave' in billing_webhook_events.provider
-- ============================================================================
-- billing_webhook_events.provider was constrained to ('stripe', 'paystack')
-- when only those two were built (20260717000000_reconcile_subscriptions_
-- for_billing.sql) — subscriptions.payment_provider already allowed
-- 'flutterwave' from the original schema, this table just lagged behind
-- since Flutterwave had no webhook handler until now.
-- ============================================================================

alter table public.billing_webhook_events
  drop constraint if exists billing_webhook_events_provider_check;

alter table public.billing_webhook_events
  add constraint billing_webhook_events_provider_check
  check (provider in ('stripe', 'paystack', 'flutterwave'));
