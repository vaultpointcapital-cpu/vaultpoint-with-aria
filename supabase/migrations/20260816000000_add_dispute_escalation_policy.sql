-- ============================================================================
-- Managed Account Dispute & Escalation Policy
-- ============================================================================
-- P0, launch-blocking for managed accounts (SEC Nigeria oversight). Per
-- spec (vaultpoint-managed-account-escalation-spec.pdf): a 4-tier
-- escalation policy (self-service -> support -> founder/compliance ->
-- legal) with authority limits, SLAs, and a full audit trail.
--
-- The spec's own dependency, a "Value Ledger PRD" event trail (fee
-- attribution ledger, net return report), does not exist as described.
-- 20260815000000_add_value_ledger.sql implements a DIFFERENT PRD
-- ("Value Realization & Business Health Monitoring") — its
-- value_ledger_events table is a real immutable event store (the right
-- shape for linked_event_ids), but nothing writes managed-account fee/
-- return events into it today. Per the spec's own Non-Negotiable #3
-- ("if the event trail can't support a dispute claim, that's a bug, not
-- a one-off miss"), linked_event_ids still points at real
-- value_ledger_events.id values but will legitimately be empty for most
-- disputes at launch — not faked, not blocking this build.
--
-- Two additions beyond the spec's literal column list, both filling
-- real gaps rather than deviating for style:
--   - parent_dispute_id: the spec says "every tier change is a new row,
--     full history preserved" but gives no column that actually links
--     the old and new rows together — unimplementable without this.
--   - managed_sub_account_id: the spec's managed_account_id assumes only
--     the VaultPoint-custodial managed_accounts table, but
--     managed_sub_accounts (Managed Trader Pathway, a second, equally
--     real managed-account product — 20260725000000) needs disputes too.
--     Mutually exclusive with managed_account_id via CHECK.
--
-- dispute_settings holds all three of the spec's "Open Items for Pells
-- to Fill In Before Build" (Tier 2 owner name, Tier 3 NGN threshold,
-- Tier 4 legal contact) as admin-editable values, same "tune without a
-- deploy" rationale as kyc_tier_limits (20260814000000). Defaults are
-- all NULL — the resolve-dispute route hard-blocks any Tier 3 refund
-- authorization while tier3_max_authorization_ngn is unset (fail closed;
-- Non-Negotiable #2: "case by case is not an auditable policy").
-- ============================================================================

create table public.dispute_settings (
  id int primary key default 1 check (id = 1), -- singleton row
  tier2_support_owner_name text,
  tier3_max_authorization_ngn numeric(18, 2),
  tier4_legal_contact text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id)
);

comment on table public.dispute_settings is
  'Singleton config row for the dispute escalation policy — see spec section 6 "Open Items for Pells to Fill In Before Build". tier3_max_authorization_ngn NULL is a hard block on Tier 3 auto-authorization, not an "unlimited" default.';

insert into public.dispute_settings (id) values (1);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  -- Links an escalation chain together (Tier 2 row -> Tier 3 row -> ...).
  -- Null on the first row of a case.
  parent_dispute_id uuid references public.disputes(id),
  user_id uuid not null references public.users(id),
  managed_account_id uuid references public.managed_accounts(id),
  managed_sub_account_id uuid references public.managed_sub_accounts(id),
  -- Escalation tier (1=self-service info only/no row, 2=support,
  -- 3=founder/compliance, 4=legal) — NOT the same vocabulary as
  -- managed_accounts.tier ('bronze'/'silver'/'gold'). Deliberately named
  -- `tier` to match the spec's own schema; do not confuse the two.
  tier int not null check (tier between 1 and 4),
  status text not null default 'open' check (status in ('open', 'resolved', 'escalated', 'closed')),
  category text not null check (category in ('fee', 'performance', 'recommendation', 'other')),
  -- Pointers into value_ledger_events.id — never a copy of that data.
  -- May legitimately be empty; see this migration's header.
  linked_event_ids uuid[] not null default '{}',
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_summary text,
  -- numeric(18,2), not the spec's literal INT — money, same convention
  -- as profit_distributions/managed_account_settlements.
  resolution_amount_ngn numeric(18, 2),
  reviewer text not null,
  escalated_from_tier int,
  escalation_reason text,
  -- Dedup guard for the SLA-breach cron (app/api/disputes/cron/sla-check)
  -- — without this, an unresolved dispute would re-alert every cron tick.
  sla_alert_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint disputes_one_account_type_only
    check (not (managed_account_id is not null and managed_sub_account_id is not null))
);

comment on table public.disputes is
  'Managed account dispute & escalation log. Every tier change is a NEW row (parent_dispute_id links the chain), never an overwrite of the prior tier''s row — full history is the point. No client insert/update/delete policy: every write goes through a Next.js route''s own auth check + service-role client.';

create index idx_disputes_status_tier on public.disputes (status, tier);
create index idx_disputes_user on public.disputes (user_id, created_at desc);
create index idx_disputes_parent on public.disputes (parent_dispute_id);

alter table public.dispute_settings enable row level security;
alter table public.disputes enable row level security;

create policy "Admins can view dispute settings"
  on public.dispute_settings for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Users can view their own disputes"
  on public.disputes for select
  using (auth.uid() = user_id);

create policy "Admins can view all disputes"
  on public.disputes for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

-- No client insert/update/delete policy on either table, for any role —
-- same "no client write on money/compliance tables" rule as every other
-- table like this in this schema (see managed_sub_accounts,
-- managed_account_audit_log). Dispute filing, escalation, resolution,
-- and settings edits all go through their own Next.js route, which
-- authenticates the caller first and writes via the service-role client.

create trigger set_updated_at before update on public.dispute_settings
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.disputes
  for each row execute procedure public.set_updated_at();
