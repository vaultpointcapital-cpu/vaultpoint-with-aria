-- ============================================================================
-- Trade journal — in-app equivalent of the Telegram Aria bot's /journal
-- command (see docs/aria-migration/01-telegram-to-in-app.md Phase 1/2).
-- Telegram's version was an append-only flat file on the VPS
-- (aria_bot/data/journal.log), keyed by Telegram user id, with zero tie
-- to a VaultPoint account. This is the real, user-scoped replacement.
-- ============================================================================

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 1000),
  created_at timestamptz not null default now()
);
comment on table public.journal_entries is
  'User-authored trade notes, logged from the Aria chat interface. Append-only, same as the Telegram bot''s journal.log was — no update/delete policy for any role.';

create index journal_entries_user_created_idx on public.journal_entries (user_id, created_at desc);

alter table public.journal_entries enable row level security;

create policy "Users can view their own journal entries"
  on public.journal_entries for select
  using (auth.uid() = user_id);

create policy "Users can create their own journal entries"
  on public.journal_entries for insert
  with check (auth.uid() = user_id);
