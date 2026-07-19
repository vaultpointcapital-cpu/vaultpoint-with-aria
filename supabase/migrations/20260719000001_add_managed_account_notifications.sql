-- ============================================================================
-- VaultPoint Managed Accounts — notifications
-- ============================================================================
-- A dedicated, real, in-app notification log for Managed Accounts —
-- deliberately NOT built on aria_conversations (20260717000004): that
-- table's own delivery pipeline (services/broker-sync/app/alert_delivery.py,
-- Resend email + an "Aria widget" reader) is code-complete but the
-- migration creating aria_conversations has never been applied anywhere,
-- and no widget UI reads it yet. Entangling Managed Accounts notifications
-- with that unfinished, unrelated pipeline would just inherit its gaps.
-- This table is self-contained: written directly by the Next.js API
-- routes that already handle onboarding/withdrawal/compliance events, read
-- by a dashboard-scoped notification list. No email/push channel is wired
-- up here either — this is in-app only, a real and complete delivery
-- channel on its own, not a stub for a channel that doesn't exist.
-- ============================================================================

create table public.managed_account_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  managed_account_id uuid references public.managed_accounts(id) not null,
  type text not null check (
    type in ('onboarding_milestone', 'distribution_requested', 'distribution_paid', 'withdrawal_window_open', 'drawdown_warning')
  ),
  title text not null,
  body text not null,
  -- drawdown_warning is the flow's own "must never be suppressed" alert
  -- (Notifications section) — read_at only controls the UI's unread
  -- badge, it never gates whether a new warning gets inserted the next
  -- time the drawdown check re-fires.
  read_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.managed_account_notifications is
  'In-app notification log for Managed Accounts: onboarding milestones, distribution/withdrawal-window notices, and drawdown risk warnings. read_at is purely a UI unread-badge flag.';

alter table public.managed_account_notifications enable row level security;

create policy "Users can view their own notifications"
  on public.managed_account_notifications for select
  using (auth.uid() = user_id);

create policy "Users can create their own notifications"
  on public.managed_account_notifications for insert
  with check (auth.uid() = user_id);

create policy "Users can mark their own notifications as read"
  on public.managed_account_notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index managed_account_notifications_user_id_created_at_idx
  on public.managed_account_notifications (user_id, created_at desc);
