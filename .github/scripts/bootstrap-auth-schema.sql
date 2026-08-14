-- Minimal stand-in for Supabase's managed `auth` schema — just enough
-- for this repo's migrations to apply cleanly against a vanilla
-- Postgres container in CI. NOT a reimplementation of Supabase Auth,
-- only the specific pieces the checked-in migrations actually
-- reference: an auth.users table with (id, email) for the
-- public.users(id) foreign key and the handle_new_user() trigger, and
-- auth.uid()/auth.role() stub functions for RLS policies.
--
-- CREATE POLICY only needs these functions to exist and be callable at
-- apply time, not to return anything meaningful — this dry-run proves
-- the migration SQL applies cleanly end to end, it does not exercise
-- RLS behavior (that needs a real Supabase Auth session, which this
-- job intentionally doesn't try to fake).
--
-- Verified locally before use: applied this file, then the full
-- migration stack (all 11 files, in order) against a genuinely fresh
-- local Postgres 17 instance with nothing else pre-installed — all 11
-- applied cleanly.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select null::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  as $$ select 'authenticated'::text $$;
