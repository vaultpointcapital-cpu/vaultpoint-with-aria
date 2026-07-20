-- ============================================================================
-- VaultPoint — production readiness: email confirmation retry flag
-- ============================================================================
-- Signup is being restructured to send its own "verify your email" message
-- via Resend (using supabase.auth.admin.generateLink() to get the
-- verification URL without Supabase's own auto-mailer sending anything) —
-- see src/app/api/auth/signup/route.ts. That decouples email delivery from
-- account creation: the account must exist even if the Resend call fails,
-- and a failed send needs to be findable later for a retry, not silently
-- lost. This is the "at least a retriable flag on the user row" version of
-- that requirement, not a full queue — proportionate to the 10-day launch
-- timeline, not a permanent architecture decision.
-- ============================================================================

alter table public.users
  add column confirmation_email_pending_retry boolean not null default false;

comment on column public.users.confirmation_email_pending_retry is
  'Set true when the verify-your-email Resend send fails at signup time (account creation itself never rolls back on that failure). POST /api/auth/resend-confirmation clears it on a successful retry. Never set for an already-confirmed user — no reason to retry a link nobody needs anymore.';

-- The "welcome" email fires once, from GET /auth/callback, the first
-- time a user's email is confirmed — never at signup (the account isn't
-- usable yet) and never again on a later /auth/callback hit for the
-- same user (a re-auth or a second magic-link click through the same
-- route must not re-send it). This is the dedupe marker for that.
alter table public.users
  add column welcome_email_sent_at timestamptz;

comment on column public.users.welcome_email_sent_at is
  'Set the first time the welcome email sends successfully (see /auth/callback). Null means never sent — checked before sending, not just recorded after, so a retry after a failed send is possible and a duplicate send on repeat callback hits is not.';
