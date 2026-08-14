-- ============================================================================
-- Managed Trader Pathway — third-party trader manages ANOTHER client's
-- capital (SEC Nigeria approved), a materially different product from
-- the existing Managed Accounts feature (VaultPoint itself manages a
-- client's own money — see 20260718000004_add_managed_accounts.sql).
-- These coexist deliberately; the two are not the same feature and this
-- migration does not touch that earlier schema. See
-- docs/managed-trader-pathway/ for the full PRD.
--
-- Schema/columns/constraints below match the PRD's technical handoff
-- doc verbatim (profit_split_pct and platform_fee_pct stored per
-- sub-account, not globally, since PRD Open Question #1 — who splits
-- with whom — isn't resolved yet and this shape supports either
-- resolution without a redesign). RLS is this migration's own addition
-- — the PRD's SQL didn't include it.
-- ============================================================================

create table public.managed_traders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended')),
  trailing_90d_return numeric(10,4),
  max_drawdown numeric(10,4),
  academy_modules_confirmed boolean not null default false,
  proposed_profit_split numeric(5,2) not null,
  approved_profit_split numeric(5,2),
  max_clients integer,
  reviewer_notes text,
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.managed_traders is
  'One row per trader application. status stays ''pending'' until an admin reviews it via POST /api/admin/managed-traders/:id/review (service-role only, see RLS below) — no auto-approval at launch, per the PRD''s Section E gate rule.';

create table public.managed_sub_accounts (
  id uuid primary key default gen_random_uuid(),
  trader_id uuid not null references public.managed_traders(id),
  client_user_id uuid not null references public.users(id),
  broker_connection_id uuid not null references public.broker_connections(id),
  status text not null default 'active' check (status in ('active', 'revoked', 'closed')),
  allocated_amount numeric(18,2) not null,
  profit_split_pct numeric(5,2) not null,
  platform_fee_pct numeric(5,2) not null,
  poa_signed_at timestamptz,
  poa_document_url text,
  poa_revoked_at timestamptz,
  disclosure_acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.managed_sub_accounts is
  'One row per client-trader capital allocation. Client retains withdrawal rights on the underlying broker_connection at all times — this row is the PoA/disclosure/split record, not a custody mechanism. Real PoA scope enforcement (trade-only, no withdrawal) lives in the broker-sync execution layer extension (PRD Sprint 4), not in this table alone.';

create table public.managed_account_settlements (
  id uuid primary key default gen_random_uuid(),
  sub_account_id uuid not null references public.managed_sub_accounts(id),
  period_start date not null,
  period_end date not null,
  realized_profit numeric(18,2) not null,
  trader_payout numeric(18,2) not null,
  platform_fee_amount numeric(18,2) not null,
  client_net numeric(18,2) not null,
  payout_status text not null default 'pending' check (payout_status in ('pending', 'paid', 'failed')),
  created_at timestamptz not null default now(),
  constraint managed_account_settlements_one_per_period unique (sub_account_id, period_start, period_end)
);
comment on table public.managed_account_settlements is
  'One row per (sub_account, settlement period) — the unique constraint is the idempotency guard against double-processing the same settlement, same pattern as profit_distributions (20260718000004) and profit_share_charges (20260718000003).';

create table public.managed_account_audit_log (
  id uuid primary key default gen_random_uuid(),
  sub_account_id uuid not null references public.managed_sub_accounts(id),
  event_type text not null, -- 'trade_executed', 'poa_signed', 'poa_revoked', 'settlement_calculated', 'payout_sent'
  event_data jsonb not null,
  created_at timestamptz not null default now()
);
comment on table public.managed_account_audit_log is
  'Append-only compliance audit trail — every trade, fee, and payout on a managed sub-account, per PRD compliance-side user story. Admin-only read (see RLS below); no update/delete policy for any role.';

create index idx_sub_accounts_trader on public.managed_sub_accounts(trader_id);
create index idx_sub_accounts_client on public.managed_sub_accounts(client_user_id);
create index idx_settlements_sub_account on public.managed_account_settlements(sub_account_id);
create index idx_audit_log_sub_account on public.managed_account_audit_log(sub_account_id);

create trigger set_updated_at before update on public.managed_traders
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.managed_sub_accounts
  for each row execute procedure public.set_updated_at();

-- ============================================================================
-- RLS
--
-- None of these tables get a client-facing INSERT/UPDATE/DELETE policy.
-- Every write (trader application, admin review, sub-account creation,
-- disclosure ack, PoA sign/revoke, settlement calculation) goes through
-- a Next.js route that authenticates the caller via session first, then
-- performs the actual write with the service-role client — never a raw
-- client-permissioned RLS write. This is deliberate: a broad client
-- UPDATE/ALL policy on a table like this is exactly the shape of bug
-- fixed in 20260724000001_restore_positions_readonly_policy.sql
-- (an undocumented "manage own rows" policy on `positions` let any user
-- overwrite rows outright). Read-only client RLS + service-role writes
-- avoids repeating that mistake here, where the tables carry real
-- money/compliance consequences.
-- ============================================================================

alter table public.managed_traders enable row level security;
alter table public.managed_sub_accounts enable row level security;
alter table public.managed_account_settlements enable row level security;
alter table public.managed_account_audit_log enable row level security;

create policy "Traders can view their own application"
  on public.managed_traders for select
  using (auth.uid() = user_id);

-- Matches the API spec's GET /api/managed-traders/:id = "Public (approved
-- only)" literally — readable by anon/unauthenticated requests too, for
-- the client-facing trader directory (PRD UI Spec Screen 1).
create policy "Anyone can view approved trader profiles"
  on public.managed_traders for select
  using (status = 'approved');

create policy "Clients can view their own sub-accounts"
  on public.managed_sub_accounts for select
  using (auth.uid() = client_user_id);

create policy "Traders can view sub-accounts under their own trader profile"
  on public.managed_sub_accounts for select
  using (
    exists (
      select 1 from public.managed_traders
      where managed_traders.id = managed_sub_accounts.trader_id
      and managed_traders.user_id = auth.uid()
    )
  );

create policy "Clients and traders can view their own settlements"
  on public.managed_account_settlements for select
  using (
    exists (
      select 1 from public.managed_sub_accounts
      where managed_sub_accounts.id = managed_account_settlements.sub_account_id
      and (
        managed_sub_accounts.client_user_id = auth.uid()
        or exists (
          select 1 from public.managed_traders
          where managed_traders.id = managed_sub_accounts.trader_id
          and managed_traders.user_id = auth.uid()
        )
      )
    )
  );

-- Admin-only, matching GET /api/admin/managed-accounts/audit-log's own
-- auth scope exactly — clients/traders see settlement summaries, not
-- the raw event-level audit trail.
create policy "Admins can view the audit log"
  on public.managed_account_audit_log for select
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true)
  );
