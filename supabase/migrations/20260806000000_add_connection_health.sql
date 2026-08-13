-- Connection Health & Data Freshness
--
-- Adds a 6-state health state machine to broker_connections, coexisting
-- with (not replacing) the existing 4-state sync_status column. sync_status
-- remains a derived, backward-compatible view maintained by the poller so
-- existing consumers keep working unchanged; health is the new, richer,
-- authoritative signal for anything freshness-aware (alert suppression,
-- Aria, the dashboard).

alter table public.broker_connections
  add column health                text not null default 'pending'
    check (health in ('pending','healthy','degraded','stale','auth_failed','closed')),
  add column last_success_at       timestamptz,
  add column last_attempt_at       timestamptz,
  add column consecutive_failures  int not null default 0,
  add column last_error_code       text,
  add column next_attempt_at       timestamptz not null default now(),
  add column closed_at             timestamptz,
  add column closed_reason         text check (closed_reason in ('user_removed','provider_closed','prop_breached')),
  -- Notification dedupe — which bad health state (if any) a notification
  -- has already been sent for, so recovery only notifies if a failure
  -- notice actually went out, and a degraded->stale->degraded flap
  -- doesn't spam.
  add column notified_health_state text;

create index broker_connections_poll_idx
  on public.broker_connections (next_attempt_at)
  where health <> 'closed';

create table public.connection_health_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.broker_connections(id) on delete cascade,
  from_health text,
  to_health text not null,
  error_code text,
  created_at timestamptz not null default now()
);
create index connection_health_events_conn_idx
  on public.connection_health_events (connection_id, created_at desc);

alter table public.portfolio_snapshots
  add column degraded boolean not null default false,
  add column degraded_sources jsonb not null default '[]'::jsonb;

-- Alert suppression — new columns on alert_history rather than a new
-- table, since alert_history is already the right shape (append-only,
-- one row per evaluation outcome).
alter table public.alert_history
  add column suppressed boolean not null default false,
  add column suppressed_reason text;

alter table public.alerts
  add column stale_notification_sent_at timestamptz;

alter table public.connection_health_events enable row level security;

create policy "Users can view own connection health events"
  on public.connection_health_events for select
  using (
    exists (
      select 1 from public.broker_connections bc
      where bc.id = connection_health_events.connection_id
        and bc.user_id = auth.uid()
    )
  );

-- down
-- alter table public.alerts drop column stale_notification_sent_at;
-- alter table public.alert_history drop column suppressed, drop column suppressed_reason;
-- alter table public.portfolio_snapshots drop column degraded, drop column degraded_sources;
-- drop table public.connection_health_events;
-- drop index broker_connections_poll_idx;
-- alter table public.broker_connections
--   drop column health,
--   drop column last_success_at,
--   drop column last_attempt_at,
--   drop column consecutive_failures,
--   drop column last_error_code,
--   drop column next_attempt_at,
--   drop column closed_at,
--   drop column closed_reason,
--   drop column notified_health_state;
