-- ============================================================================
-- Step-Up Auth — Ticket 6: new device login alerts.
-- ============================================================================
-- There is no server-side "session created" hook for the actual password
-- login path in this codebase — src/app/(auth)/login/page.tsx calls
-- supabase.auth.signInWithPassword() directly from the browser, the same
-- gap GET /auth/callback's own welcome-email comment doesn't have to deal
-- with (that route IS server-side, for the magic-link/email-confirmation
-- path only). So this "hooks into existing session creation logic" by
-- having the login page call POST /api/auth/login-device immediately after
-- a successful sign-in — see src/lib/auth/login-alerts.ts.
--
-- A "device" here is an opaque, unguessable value the browser persists in
-- a long-lived httpOnly cookie, set on first recognition. Only its hash is
-- stored — nothing here needs the raw value to compare, and there's no
-- reason to keep a reversible copy of a bearer-ish token server-side.
-- Scoped to the web login flow only; the mobile apps and Telegram bot live
-- outside this repo and aren't covered.
-- ============================================================================

create table public.login_device_fingerprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  fingerprint_hash text not null,
  user_agent text,
  first_seen_ip text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint login_device_fingerprints_unique_per_user unique (user_id, fingerprint_hash)
);

comment on table public.login_device_fingerprints is
  'Recognized browser fingerprints per user (Step-Up Auth Ticket 6). No client insert/update/delete policy — every write goes through service-role code in src/lib/auth/login-alerts.ts, same pattern as user_devices and step_up_approvals.';

create index login_device_fingerprints_user_idx on public.login_device_fingerprints (user_id);

alter table public.login_device_fingerprints enable row level security;

create policy "Users can view their own recognized login devices"
  on public.login_device_fingerprints for select
  using (auth.uid() = user_id);
