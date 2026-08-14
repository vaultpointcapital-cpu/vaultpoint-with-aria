-- ============================================================================
-- VaultPoint — restore 'flutterwave' to subscriptions.payment_provider
-- ============================================================================
-- The original schema (20260617000000_initial_schema.sql) allowed
-- payment_provider in ('stripe', 'paystack', 'flutterwave'). A later
-- migration (20260717000000_reconcile_subscriptions_for_billing.sql)
-- dropped and recreated this constraint while reconciling drift between
-- live and the migration stack, narrowing it to ('stripe', 'paystack') —
-- apparently unintentionally, since Flutterwave was never built at that
-- point and nobody noticed the narrower constraint until building the
-- actual Flutterwave webhook handler surfaced it as a real 23514 failure
-- on every single Flutterwave charge.
-- ============================================================================

alter table public.subscriptions
  drop constraint if exists subscriptions_payment_provider_check;

alter table public.subscriptions
  add constraint subscriptions_payment_provider_check
  check (payment_provider in ('stripe', 'paystack', 'flutterwave'));
