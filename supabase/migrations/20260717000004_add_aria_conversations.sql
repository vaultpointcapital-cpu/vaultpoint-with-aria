-- ============================================================================
-- VaultPoint — Aria conversation history (Telegram + web parity)
-- ============================================================================
-- Timestamped after the full DB reconciliation stack, which now ends at
-- 20260717000003_fix_handle_new_user_email.sql, not 000002 as originally
-- assumed when this migration was requested — 000003 was a real bug found
-- and fixed mid-reconciliation (handle_new_user() never populated
-- users.email). This file is sequenced after it.
--
-- No existing conversation-history table for the Telegram bot was found
-- anywhere in this repo (nor any Telegram bot code at all — see the Aria
-- workstream's own stop condition). This is a fresh table, not an
-- extension of something pre-existing.
--
-- channel distinguishes Telegram vs web from day one, per instruction,
-- so a future Telegram-side migration to this same table (if the bot is
-- ever moved onto it) doesn't require another schema change.
--
-- message_type accommodates both conversational turns (CHAT, null for
-- plain user messages) and proactive/engine-fired rows (LOSS_WARNING,
-- PROFIT_ALERT, BUY_SIGNAL, PORTFOLIO_REVIEW, MARKET_UPDATE,
-- IDLE_CHECK_IN, RISK_CHECK, COMMUNITY_NUDGE) — the Alert Engine
-- workstream inserts rows here for in-app delivery once it exists.
--
-- NOT applied to any database (local, shadow, or live) — SQL only, per
-- instruction. Live is mid-reconciliation and migrations are applied by
-- hand, in order, by the project owner.
-- ============================================================================

create table public.aria_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  channel text not null check (channel in ('telegram', 'web')),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  message_type text check (
    message_type is null
    or message_type in (
      'CHAT',
      'LOSS_WARNING',
      'PROFIT_ALERT',
      'BUY_SIGNAL',
      'PORTFOLIO_REVIEW',
      'MARKET_UPDATE',
      'IDLE_CHECK_IN',
      'RISK_CHECK',
      'COMMUNITY_NUDGE'
    )
  ),
  created_at timestamptz not null default now()
);

comment on column public.aria_conversations.channel is
  'telegram | web — which surface this message came from/was delivered to. Both share this table so a user''s context persists across surfaces.';
comment on column public.aria_conversations.message_type is
  'Null for a plain conversational turn (chat). Set for proactive/engine-fired rows (loss warnings, profit alerts, etc.) — see Alert Engine and Aria in-app workstreams. CHAT is an explicit value for a user-initiated message that should still be tagged.';

create index idx_aria_conversations_user on public.aria_conversations(user_id, created_at);

alter table public.aria_conversations enable row level security;

create policy "Users can view own conversations" on public.aria_conversations
  for select using (auth.uid() = user_id);
