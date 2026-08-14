-- ============================================================================
-- Automated Profit-Split Payout Calculation — safe-core scope
-- ============================================================================
-- Per vaultpoint-payout-calculation-spec.pdf, scoped down after verifying
-- the spec's claimed dependencies against this codebase: payout_ledger,
-- prop_firm_orders, managed_prop_accounts, and a generic audit_logs table
-- are fictional names — none existed before this migration. The Hantec
-- Instant connection (Partner Offers v1, 20260803000000_add_partner_offers.sql)
-- is explicitly read-only/execution-incapable, and nothing anywhere
-- persists or diffs MT5 balances, so withdrawal detection is net-new, not
-- an extension of existing logic.
--
-- Scope decision (confirmed with the user): build only what doesn't
-- depend on unverified/nonexistent capability. The spec's Option D
-- ("single withdrawal action with two destinations") needs a Hantec API
-- capability nobody has confirmed exists — brokers overwhelmingly don't
-- expose this, for AML reasons (a withdrawal goes to one KYC-verified
-- destination). Option E (custodial forwarding) needs real crypto
-- deposit-address/on-chain-monitoring infrastructure that is an explicit,
-- documented non-functional placeholder elsewhere in this codebase
-- (src/lib/wallet/web3-adapter.ts). Neither is built here. What IS built:
-- detection, a DB-layer split-calculation engine, a manual review surface,
-- full audit trail, and the app-guided two-step withdrawal flow (VaultPoint
-- computes and displays the split; the trader executes both legs
-- themselves via Hantec's normal single-destination withdrawal) plus
-- Stripe-only fiat auto-charge for VaultPoint's cut.
--
-- No client insert/update/delete policy anywhere in this migration, for
-- any table — every write goes through a route's service-role client or
-- calculate_payout_split() below, same rule as every other money/
-- compliance table in this schema.
-- ============================================================================

create table public.prop_payout_agreements (
  id uuid primary key default gen_random_uuid(),
  broker_connection_id uuid not null references public.broker_connections(id) unique,
  user_id uuid not null references public.users(id),
  funding_partner text not null default 'hantec_trader',
  -- Trader's share, 0-100. Issue #13's "split direction" question was
  -- explicitly left unresolved even in the Managed Trader Pathway build
  -- (20260725000000's own comment: "who splits with whom isn't resolved
  -- yet") — split_direction below is this migration's concrete answer,
  -- not a silent guess.
  profit_split_pct numeric(5, 2) not null check (profit_split_pct > 0 and profit_split_pct <= 100),
  -- Governs which side absorbs a rounding remainder once a
  -- funding_partner_amount cut is also present: 'trader_first' computes
  -- the trader's amount off profit_split_pct and VaultPoint absorbs the
  -- remainder; 'platform_first' computes VaultPoint's amount off
  -- (100 - profit_split_pct) and the trader absorbs the remainder. See
  -- calculate_payout_split() below.
  split_direction text not null default 'trader_first' check (split_direction in ('trader_first', 'platform_first')),
  -- Set by the TRADER (PUT /api/prop-payout-agreements/:id/wallet), never
  -- by an admin — presence of this determines collection_method in
  -- calculate_payout_split(): set -> crypto_two_step, null -> fiat_card_charge.
  trader_payout_wallet_address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.prop_payout_agreements is
  'One row per prop-funded broker_connections entry — the "profit split agreement" record Issue #13 assumed existed. No such record existed anywhere before this migration.';

-- The missing piece: get_balance() is called today only as a liveness
-- probe for simulated connections (services/broker-sync/app/sync_service.py)
-- and the number is never stored. This is the real balance time series
-- app/payout_detection.py needs to diff against.
create table public.account_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  broker_connection_id uuid not null references public.broker_connections(id),
  balance numeric not null,
  synced_at timestamptz not null default now()
);

create index idx_account_balance_snapshots_connection on public.account_balance_snapshots (broker_connection_id, synced_at desc);

comment on table public.account_balance_snapshots is
  'Real balance time series per broker connection, written by app/payout_detection.py every poll cycle for connections with an active prop_payout_agreements row. Did not exist anywhere before this migration.';

create table public.withdrawal_events (
  id uuid primary key default gen_random_uuid(),
  broker_connection_id uuid not null references public.broker_connections(id),
  user_id uuid not null references public.users(id),
  detected_amount numeric not null check (detected_amount > 0),
  balance_before numeric not null,
  balance_after numeric not null,
  detected_at timestamptz not null default now(),
  sync_source text not null default 'broker_sync_poll',
  -- 'auto_detected': a clean, unambiguous drop with no offsetting
  -- concurrent trade activity — still requires an admin action before
  -- any collection step, this only skips the "is this even real" check.
  -- 'requires_manual_confirmation': anything messier; sits until
  -- POST /api/admin/withdrawal-events/:id/confirm. Heuristic, flagged as
  -- needing tuning against real data — see app/payout_detection.py.
  confidence text not null check (confidence in ('auto_detected', 'requires_manual_confirmation')),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  created_at timestamptz not null default now()
);

create index idx_withdrawal_events_status on public.withdrawal_events (status, confidence);
create index idx_withdrawal_events_user on public.withdrawal_events (user_id, created_at desc);

comment on table public.withdrawal_events is
  'Detected balance-reducing events consistent with a withdrawal (spec section 3.1). No auto-finalized payout without either high-confidence detection or manual sign-off (section 3.3) — this table + calculate_payout_split() is that gate.';

-- The real table the spec assumed already existed under this exact name.
create table public.payout_ledger (
  id uuid primary key default gen_random_uuid(),
  withdrawal_event_id uuid not null references public.withdrawal_events(id) unique,
  agreement_id uuid not null references public.prop_payout_agreements(id),
  broker_connection_id uuid not null references public.broker_connections(id),
  user_id uuid not null references public.users(id),
  withdrawal_amount numeric not null,
  trader_amount numeric not null,
  vaultpoint_amount numeric not null,
  funding_partner_amount numeric not null default 0,
  split_direction text not null,
  collection_method text not null check (collection_method in ('crypto_two_step', 'fiat_card_charge')),
  status text not null default 'pending'
    check (status in ('pending', 'pending_trader_execution', 'collected', 'disputed', 'failed')),
  trader_wallet_address text,
  vaultpoint_wallet_address text,
  -- Set when the trader tells VaultPoint they've sent both legs of their
  -- Hantec withdrawal (POST .../mark-trader-executed) — a claim, not
  -- proof. status only moves to 'collected' on independent confirmation
  -- (confirm-collected), since no wallet-monitoring capability exists in
  -- this codebase to verify the claim automatically
  -- (src/lib/wallet/web3-adapter.ts documents that gap explicitly).
  trader_marked_executed_at timestamptz,
  collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_payout_ledger_status on public.payout_ledger (status);
create index idx_payout_ledger_user on public.payout_ledger (user_id, created_at desc);

comment on table public.payout_ledger is
  'One row per calculated split, written only by calculate_payout_split(). Immutable once status=''collected'' — see prevent_collected_payout_ledger_edit() below; corrections require a new offsetting entry (a fresh withdrawal_event/payout_ledger pair), never an edit.';

create table public.payout_calculation_audit_log (
  id uuid primary key default gen_random_uuid(),
  withdrawal_event_id uuid not null references public.withdrawal_events(id),
  payout_ledger_id uuid not null references public.payout_ledger(id),
  input jsonb not null,
  output jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.payout_calculation_audit_log is
  'One row per calculate_payout_split() call, full input/output — required given this touches real payout amounts (spec section 3.5). Feature-scoped, matching this codebase''s one-audit-table-per-feature convention (managed_account_audit_log, step_up_audit_log) rather than a generic audit_logs table, which does not exist anywhere in this schema.';

create table public.payout_settings (
  id int primary key default 1 check (id = 1), -- singleton, same convention as dispute_settings
  vaultpoint_crypto_wallet_address text,
  vaultpoint_crypto_network text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id)
);

insert into public.payout_settings (id) values (1);

comment on table public.payout_settings is
  'Singleton config — where VaultPoint''s cut should be sent for the crypto_two_step collection method. Null blocks calculate_payout_split() from populating vaultpoint_wallet_address on new payout_ledger rows, same fail-safe-when-unconfigured posture as dispute_settings.tier3_max_authorization_ngn.';

create index idx_prop_payout_agreements_user on public.prop_payout_agreements (user_id);

alter table public.prop_payout_agreements enable row level security;
alter table public.account_balance_snapshots enable row level security;
alter table public.withdrawal_events enable row level security;
alter table public.payout_ledger enable row level security;
alter table public.payout_calculation_audit_log enable row level security;
alter table public.payout_settings enable row level security;

create policy "Users can view their own payout agreement"
  on public.prop_payout_agreements for select
  using (auth.uid() = user_id);
create policy "Admins can view all payout agreements"
  on public.prop_payout_agreements for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view balance snapshots"
  on public.account_balance_snapshots for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Users can view their own withdrawal events"
  on public.withdrawal_events for select
  using (auth.uid() = user_id);
create policy "Admins can view all withdrawal events"
  on public.withdrawal_events for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Users can view their own payout ledger entries"
  on public.payout_ledger for select
  using (auth.uid() = user_id);
create policy "Admins can view all payout ledger entries"
  on public.payout_ledger for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view the payout calculation audit log"
  on public.payout_calculation_audit_log for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view payout settings"
  on public.payout_settings for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create trigger set_updated_at before update on public.prop_payout_agreements
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.payout_ledger
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.payout_settings
  for each row execute procedure public.set_updated_at();

-- ============================================================================
-- Immutability: once a payout_ledger row is collected, it cannot be
-- edited — spec section 3.5's "corrections require a new offsetting
-- entry, never an edit," enforced at the DB layer rather than trusted to
-- application code (the same trust boundary decision as this codebase's
-- other DB-layer enforcement, e.g. kyc_tier_limits/confirm_step_up_approval).
-- ============================================================================
create or replace function public.prevent_collected_payout_ledger_edit()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'collected' then
    raise exception 'payout_ledger row % is collected and immutable — corrections require a new offsetting entry, never an edit', old.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger prevent_collected_payout_ledger_edit
  before update on public.payout_ledger
  for each row execute procedure public.prevent_collected_payout_ledger_edit();

-- ============================================================================
-- calculate_payout_split — the DB-layer calculation engine (spec 3.2).
-- security invoker: same posture as value_ledger_apply_event/
-- confirm_step_up_approval — only ever called from a service-role context
-- (app/payout_detection.py directly, or a Next.js admin route's
-- createServiceClient()), never by an end-user session, since none of
-- these tables carry a client insert policy.
--
-- Idempotent: a payout_ledger row already existing for this
-- withdrawal_event_id (the unique constraint above) short-circuits to
-- returning that row unchanged, rather than computing — and auditing — a
-- second, possibly-different split for the same event.
-- ============================================================================
create or replace function public.calculate_payout_split(p_withdrawal_event_id uuid)
returns public.payout_ledger
language plpgsql
security invoker
as $$
declare
  v_event public.withdrawal_events;
  v_agreement public.prop_payout_agreements;
  v_settings public.payout_settings;
  v_trader_amount numeric;
  v_vaultpoint_amount numeric;
  v_funding_partner_amount numeric := 0; -- no funding-partner split logic beyond trader/platform yet
  v_collection_method text;
  v_status text;
  v_ledger public.payout_ledger;
begin
  select * into v_event from public.withdrawal_events where id = p_withdrawal_event_id for update;
  if not found then
    raise exception 'withdrawal_event % not found', p_withdrawal_event_id using errcode = 'P0001';
  end if;

  select * into v_ledger from public.payout_ledger where withdrawal_event_id = p_withdrawal_event_id;
  if found then
    return v_ledger;
  end if;

  select * into v_agreement from public.prop_payout_agreements
    where broker_connection_id = v_event.broker_connection_id and active = true;
  if not found then
    raise exception 'No active payout agreement for broker_connection %', v_event.broker_connection_id
      using errcode = 'P0001';
  end if;

  select * into v_settings from public.payout_settings where id = 1;

  if v_agreement.split_direction = 'trader_first' then
    v_trader_amount := round(v_event.detected_amount * v_agreement.profit_split_pct / 100, 2);
    v_vaultpoint_amount := v_event.detected_amount - v_trader_amount - v_funding_partner_amount;
  else
    v_vaultpoint_amount := round(v_event.detected_amount * (100 - v_agreement.profit_split_pct) / 100, 2);
    v_trader_amount := v_event.detected_amount - v_vaultpoint_amount - v_funding_partner_amount;
  end if;

  v_collection_method := case when v_agreement.trader_payout_wallet_address is not null then 'crypto_two_step' else 'fiat_card_charge' end;
  v_status := case when v_collection_method = 'crypto_two_step' then 'pending_trader_execution' else 'pending' end;

  insert into public.payout_ledger (
    withdrawal_event_id, agreement_id, broker_connection_id, user_id,
    withdrawal_amount, trader_amount, vaultpoint_amount, funding_partner_amount,
    split_direction, collection_method, status,
    trader_wallet_address, vaultpoint_wallet_address
  ) values (
    v_event.id, v_agreement.id, v_event.broker_connection_id, v_event.user_id,
    v_event.detected_amount, v_trader_amount, v_vaultpoint_amount, v_funding_partner_amount,
    v_agreement.split_direction, v_collection_method, v_status,
    v_agreement.trader_payout_wallet_address, v_settings.vaultpoint_crypto_wallet_address
  )
  returning * into v_ledger;

  insert into public.payout_calculation_audit_log (withdrawal_event_id, payout_ledger_id, input, output)
  values (
    v_event.id,
    v_ledger.id,
    jsonb_build_object('withdrawal_event', to_jsonb(v_event), 'agreement', to_jsonb(v_agreement)),
    to_jsonb(v_ledger)
  );

  return v_ledger;
end;
$$;

comment on function public.calculate_payout_split is
  'Reads a withdrawal_event + its prop_payout_agreements row, computes the trader/VaultPoint split per split_direction, writes payout_ledger + payout_calculation_audit_log atomically. Idempotent on withdrawal_event_id. security invoker — callable only from a service-role context.';
