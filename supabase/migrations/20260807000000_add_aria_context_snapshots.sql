-- Aria Context Builder
--
-- Stores the exact sanitized payload buildAriaContext() sent to the model,
-- once per fresh (non-cached) build — the reproducibility goal behind the
-- spec's D6 ("payload versioned and snapshotted with each conversation").
-- Scoped down from "with each conversation": no server-side conversation
-- history exists on the web chat surface today (aria_conversations.Insert
-- is 'never' on the TS side, and no route writes to it — see the Aria
-- Context Builder plan's reconciliation notes), so this snapshots the
-- payload itself rather than a conversation thread that doesn't exist.
--
-- 30-day retention: services/broker-sync/app/scheduler.py's
-- cleanup_expired_aria_snapshots job deletes rows past expires_at daily,
-- following the same lock/heartbeat pattern as its other 5 jobs.

create table public.aria_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  version text not null default '1',
  payload jsonb not null,
  generated_at timestamptz not null,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);

create index aria_context_snapshots_user_idx
  on public.aria_context_snapshots (user_id, created_at desc);

create index aria_context_snapshots_expires_idx
  on public.aria_context_snapshots (expires_at);

alter table public.aria_context_snapshots enable row level security;

create policy "Users can view their own Aria context snapshots"
  on public.aria_context_snapshots for select
  using (user_id = auth.uid());

-- buildAriaContext() runs on the RLS-respecting client (createClient()),
-- same as every other Valuation Contract read it does — self-service
-- insert, same shape as usage_events' own policy, rather than pulling
-- in the service-role client for one write in an otherwise
-- anon-key-only module.
create policy "Users can log their own Aria context snapshots"
  on public.aria_context_snapshots for insert
  with check (user_id = auth.uid());

-- down
-- drop table public.aria_context_snapshots;
