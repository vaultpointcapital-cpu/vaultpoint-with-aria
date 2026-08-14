-- ============================================================================
-- VaultPoint — first-party usage/engagement analytics
-- ============================================================================
-- Month 1 post-launch roadmap item: "actual feature engagement" (pod
-- creation rate, alert trigger->action rate, session frequency), not just
-- Sentry's error tracking. No product-analytics vendor (PostHog, Mixpanel,
-- etc.) is integrated anywhere in this codebase and picking one is a real
-- decision (cost, data residency, another vendor account) left open rather
-- than made here — this is a minimal first-party events table in the same
-- shape as disclosure_views/alert_history, queryable directly via SQL,
-- that can be piped into a real analytics tool later without losing
-- whatever history already accumulated.
--
-- "alert trigger->action rate" specifically: alert_history already records
-- every trigger (written server-side by services/broker-sync/app/
-- alert_engine.py). This table adds the "action" half only
-- (alert_toggled/alert_deleted events) — the rate itself is a join query
-- between the two tables by user_id/time proximity, not a new column
-- anywhere.
-- ============================================================================

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
comment on table public.usage_events is
  'First-party feature-engagement analytics (pod creation, alert actions, session starts, page views) — distinct from Sentry (errors only). See migration header for why this is first-party rather than a vendor integration.';

alter table public.usage_events enable row level security;

-- Insert-only from the client's own RLS-scoped session — analytics
-- writes happen fire-and-forget from the browser, never blocking the UI
-- (see src/lib/analytics/track.ts). No select policy for regular users:
-- this is written to be queried by analysts/admins via the service-role
-- client, not read back in-app.
create policy "Users can log their own usage events"
  on public.usage_events for insert
  with check (auth.uid() = user_id);

create index usage_events_event_name_created_at_idx
  on public.usage_events (event_name, created_at desc);
create index usage_events_user_id_created_at_idx
  on public.usage_events (user_id, created_at desc);
