-- ============================================================================
-- Step-Up Auth — Ticket 4: Telegram approval channel.
-- ============================================================================
-- Nothing in this codebase (or the Telegram bot infra checked alongside
-- it) links a Telegram chat to a VaultPoint user_id today — the bot
-- copies available for reference were either an outdated prototype or a
-- single-tenant personal tool hardcoded to one TELEGRAM_CHAT_ID env var,
-- not the multi-user assistant the ecosystem docs describe. So this
-- ticket builds real, self-contained account linking here rather than
-- assuming a mapping that doesn't actually exist anywhere: a short-lived
-- code shown in-app, sent to the bot as "/link CODE", completes the
-- link. See src/lib/auth/telegram-link.ts.
--
-- Same real-but-not-fully-wired trade-off as Ticket 1: this builds
-- linking, message construction, and webhook processing for real, but
-- actually SENDING a Telegram message needs TELEGRAM_BOT_TOKEN, which
-- isn't provisioned anywhere in this codebase's env files.
-- ============================================================================

alter type step_up_method add value if not exists 'telegram';

create table public.telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint telegram_link_codes_unique_code unique (code)
);

comment on table public.telegram_link_codes is
  'Short-lived one-time codes (Step-Up Auth Ticket 4) a user sends to the bot as "/link CODE" to prove they own a given Telegram chat. No client insert/update/delete policy — every write goes through service-role code in src/lib/auth/telegram-link.ts.';

create index telegram_link_codes_user_idx on public.telegram_link_codes (user_id);

alter table public.telegram_link_codes enable row level security;

create policy "Users can view their own telegram link codes"
  on public.telegram_link_codes for select
  using (auth.uid() = user_id);

create table public.telegram_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  chat_id text not null,
  linked_at timestamptz not null default now(),
  constraint telegram_links_unique_per_user unique (user_id),
  constraint telegram_links_unique_per_chat unique (chat_id)
);

comment on table public.telegram_links is
  'One Telegram chat per user (Step-Up Auth Ticket 4) — a physical chat is treated as belonging to whichever user most recently linked it, same reassignment reasoning as user_devices (Ticket 1). No client insert/update/delete policy.';

alter table public.telegram_links enable row level security;

create policy "Users can view their own telegram link"
  on public.telegram_links for select
  using (auth.uid() = user_id);
