-- ============================================================================
-- VaultPoint — production readiness: subscriptions race condition + schema drift
-- ============================================================================
-- Found during the production-readiness audit of the Paystack webhook
-- handler (src/app/api/webhooks/paystack/route.ts, charge.success branch):
-- it does select-then-insert on provider_customer_id with NO unique
-- constraint backing it. Two concurrent charge.success deliveries for the
-- same brand-new customer (a realistic scenario — Paystack can and does
-- send events close together) can both see no existing row and both
-- insert, producing two subscriptions rows for one user. Every other
-- idempotency guard in this schema (billing_webhook_events,
-- profit_share_charges, profit_distributions) is a DB-level unique
-- constraint precisely because app-level select-then-branch has this
-- exact race — this is the one place that pattern was missed.
--
-- Also documents real schema drift found while verifying the above on
-- shadow (which mirrors live): 20260617000000_initial_schema.sql declares
-- provider_subscription_id `not null`, but live/shadow has never actually
-- enforced that — confirmed by a real insert with a null value succeeding
-- on shadow. This doesn't matter for live/shadow (already permissive) but
-- DOES matter for a fresh database built straight from the migration
-- stack (e.g. CI's migration dry-run, or a new environment) — declared
-- explicitly here rather than left as silent drift between what the
-- migrations claim and what the running databases actually enforce.
-- ============================================================================

alter table public.subscriptions
  alter column provider_subscription_id drop not null;

-- Partial (not full-column) unique index: provider_customer_id is null
-- for rows that haven't completed a first successful charge yet, and
-- multiple such rows must not collide with each other. Scoped by
-- payment_provider too, not just provider_customer_id alone — Stripe and
-- Paystack customer id formats differ enough that a cross-provider
-- collision is practically impossible, but this is the precise,
-- unambiguous invariant rather than relying on incidental format
-- differences never colliding.
create unique index if not exists idx_subscriptions_provider_customer_unique
  on public.subscriptions (payment_provider, provider_customer_id)
  where provider_customer_id is not null;

comment on index public.idx_subscriptions_provider_customer_unique is
  'Idempotency guard for the Paystack/Stripe charge.success upsert (see webhook route handlers) — without this, two concurrent webhook deliveries for the same new customer could each pass a select-then-insert check and create duplicate subscription rows.';
