-- ============================================================================
-- Step-Up Auth — Ticket 1: device registration & push infra.
-- Push credentials (APNs/FCM) are NOT provisioned anywhere in this
-- codebase as of this migration (checked .env.example — zero
-- push-related vars) — this only builds the registration/storage half
-- the ticket calls a non-blocked prerequisite; actually sending a push
-- is separate follow-up work once those credentials exist.
-- ============================================================================

create type device_platform as enum ('ios', 'android');

create table public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  platform device_platform not null,
  -- AES-256-GCM via src/lib/encryption/broker-keys.ts (same module
  -- broker credentials use — generic, not broker-specific despite the
  -- file name). That module uses a random IV per call, so the same raw
  -- token encrypts to different ciphertext each time — device_token_hash
  -- below is what makes "this device already registered" detectable
  -- without decrypting every existing row to compare.
  encrypted_device_token text not null,
  device_token_iv text not null,
  device_token_hash text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Global, not per-user: a physical device token is the real-world
  -- identity here. If a different VaultPoint user logs in on the same
  -- device later, re-registration re-assigns this row's user_id rather
  -- than creating a second row for the same physical device.
  constraint user_devices_unique_token_hash unique (device_token_hash)
);
comment on table public.user_devices is
  'Registered push-notification device tokens (Step-Up Auth Ticket 1). No client update/delete policy — re-registration and removal both go through the service-role register route, never a raw client write.';

create index user_devices_user_idx on public.user_devices (user_id);

create trigger set_updated_at before update on public.user_devices
  for each row execute procedure public.set_updated_at();

alter table public.user_devices enable row level security;

create policy "Users can view their own registered devices"
  on public.user_devices for select
  using (auth.uid() = user_id);
