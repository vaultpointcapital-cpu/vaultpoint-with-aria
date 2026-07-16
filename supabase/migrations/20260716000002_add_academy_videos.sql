-- ============================================================================
-- VaultPoint — Meir FX Academy video content
-- Added mid-sprint per founder request
-- ============================================================================
-- Shared content, not per-user data — no user_id ownership column, no
-- CRUD API routes. The founder manages rows directly via the Supabase
-- Table Editor (the same dashboard used to run migrations); a full admin
-- CMS is deliberately not built for 2-3 videos. Revisit only if content
-- management becomes frequent/collaborative enough to justify it.
--
-- Daily rotation needs no cron: exactly one row with
-- video_type = 'daily_short' and is_active = true at a time. To swap it,
-- the founder edits that row directly (or flips is_active on the old one
-- and on a new one) — no automatic date-based rotation logic.
-- ============================================================================

create table public.academy_videos (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  description text,
  video_provider text not null check (video_provider in ('youtube', 'vimeo')),
  video_id text not null,              -- the provider's video id, e.g. YouTube's "dQw4w9WgXcQ"
  video_type text not null check (video_type in ('long_form', 'daily_short')),
  thumbnail_url text,                  -- optional manual thumbnail; falls back to the provider's default if null
  display_order integer not null default 0,  -- controls ordering within the long_form list
  is_active boolean not null default true,   -- toggle to hide without deleting
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.academy_videos is
  'Meir FX Academy video content (embedded YouTube/Vimeo, not self-hosted). Founder-managed via Supabase Table Editor — no admin UI, no per-user ownership.';

create index idx_academy_videos_type_active on public.academy_videos(video_type, is_active);

alter table public.academy_videos enable row level security;

-- All authenticated users can read active videos — shared content. No
-- insert/update/delete policy for regular users; only the founder (via
-- Table Editor, using elevated dashboard access) manages this table.
create policy "authenticated_users_can_view_active_academy_videos"
  on public.academy_videos
  for select
  using (auth.role() = 'authenticated' and is_active = true);
