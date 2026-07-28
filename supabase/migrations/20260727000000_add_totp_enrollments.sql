-- ============================================================================
-- Step-Up Auth — Ticket 3: TOTP fallback (enrollment + verify).
-- ============================================================================
-- One enrollment per user (re-enrolling replaces it — there's no separate
-- "disable TOTP" flow in this ticket's scope, so upsert is simpler than a
-- dedicated deactivation path nobody asked for). The secret is encrypted
-- at rest via src/lib/encryption/broker-keys.ts (same AES-256-GCM module
-- broker credentials and Ticket 1's device tokens already use).
--
-- last_consumed_counter is what makes this actually replay-safe: RFC 6238
-- alone doesn't stop the same 30s code being reused twice within its
-- valid window, so src/lib/auth/totp.ts's verifyTotpCode() refuses any
-- counter at or before this value, and every successful verify (both
-- enrollment activation and later step-up confirms) advances it.
-- ============================================================================

create type totp_enrollment_status as enum ('pending', 'active');

create table public.totp_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  encrypted_secret text not null,
  secret_iv text not null,
  status totp_enrollment_status not null default 'pending',
  last_consumed_counter bigint,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  constraint totp_enrollments_unique_per_user unique (user_id)
);

comment on table public.totp_enrollments is
  'One TOTP enrollment per user (Step-Up Auth Ticket 3). No client insert/update/delete policy — every write goes through service-role code in src/lib/auth/totp-enrollment.ts, same pattern as user_devices and step_up_approvals. Re-enrolling upserts this row (on the user_id unique constraint) rather than erroring.';

alter table public.totp_enrollments enable row level security;

create policy "Users can view their own TOTP enrollment status"
  on public.totp_enrollments for select
  using (auth.uid() = user_id);
