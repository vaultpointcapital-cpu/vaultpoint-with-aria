-- ============================================================================
-- VaultPoint — fix: partial unique index unusable as ON CONFLICT target
-- ============================================================================
-- Found running the Day 1 launch-sprint billing cycle test
-- (scripts/test-billing-cycle.mjs) against a real Paystack charge.success
-- webhook call: the Paystack webhook handler's upsert
-- (.upsert(..., { onConflict: 'payment_provider,provider_customer_id' }))
-- fails every time with Postgres error 42P10 "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- Root cause: idx_subscriptions_provider_customer_unique
-- (20260720000001_fix_subscriptions_race_and_drift.sql) is a PARTIAL
-- index (`where provider_customer_id is not null`). Postgres only lets a
-- partial index serve as an ON CONFLICT arbiter if the INSERT's own ON
-- CONFLICT clause repeats that exact WHERE predicate — verified directly
-- against the shadow project: `on conflict (payment_provider,
-- provider_customer_id) do update ...` fails with 42P10 against this
-- index, but adding `where provider_customer_id is not null` to the same
-- ON CONFLICT clause succeeds. The Supabase JS client's `.upsert()` /
-- `onConflict` option has no way to express that WHERE predicate — it
-- only takes a column list — so this upsert could never succeed as
-- written, on shadow OR live.
--
-- Impact confirmed live-equivalent (same schema, same code): every
-- brand-new Paystack subscriber's first charge.success webhook hits this
-- exact upsert branch (existing === null, since select-then-branch found
-- no prior row) and would 500. Before this session's separate fix to stop
-- swallowing webhook write errors, this failed completely silently —
-- Paystack received 200 "received:true" and never retried, so the
-- subscription row was simply never created and the user stayed on
-- 'free' forever despite a successful charge.
--
-- Fix: drop the partial index, replace with a full (non-partial) unique
-- index on the same two columns. Verified this preserves the original
-- intent — Postgres unique indexes never treat NULL as equal to another
-- NULL by default, so multiple pending rows with provider_customer_id
-- NULL for the same payment_provider are still allowed, exactly as the
-- partial index intended — while now also being usable, with no WHERE
-- predicate, as a plain `onConflict: 'payment_provider,provider_customer_id'`
-- arbiter, matching what the Supabase client actually generates.
-- ============================================================================

drop index if exists public.idx_subscriptions_provider_customer_unique;

create unique index if not exists idx_subscriptions_provider_customer_unique
  on public.subscriptions (payment_provider, provider_customer_id);

comment on index public.idx_subscriptions_provider_customer_unique is
  'Idempotency guard for the Paystack/Stripe charge.success upsert (see webhook route handlers). Deliberately a FULL (non-partial) unique index, not partial — Postgres unique indexes already allow unlimited NULL provider_customer_id rows per payment_provider by default, and a full index (unlike a partial one) can be used as an ON CONFLICT arbiter by a plain column-list onConflict clause, which is all the Supabase JS client can express. A prior partial version of this index (20260720000001) could not actually be used by the app''s upsert call at all — see 20260720000002 for the failure this caused.';
