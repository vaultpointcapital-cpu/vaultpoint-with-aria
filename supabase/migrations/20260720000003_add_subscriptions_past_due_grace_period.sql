-- ============================================================================
-- VaultPoint — 3-day grace period on past_due before revoking access
-- ============================================================================
-- Product decision from the Day 2 billing test review: a renewal decline
-- was revoking access immediately (getUserTier only counted active/
-- trialing rows). User asked for a grace period instead.
--
-- past_due_since records when a subscription row FIRST entered past_due
-- (not touched on subsequent invoice.payment_failed retries for the same
-- outage, so the grace window doesn't keep extending), and is cleared to
-- null the moment the subscription recovers to active/trialing. NULL
-- means "not currently past_due" or "no timestamp recorded" — either way
-- the grace-period query (get-user-tier.ts) treats NULL as no grace,
-- which is the fail-safe (access-denying) direction.
-- ============================================================================

alter table public.subscriptions
  add column if not exists past_due_since timestamptz;

comment on column public.subscriptions.past_due_since is
  'When this row first entered past_due status (set once per decline episode, cleared on recovery). Used by get-user-tier.ts to grant a 3-day grace period before revoking access on a failed renewal charge.';
