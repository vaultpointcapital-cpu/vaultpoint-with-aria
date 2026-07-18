-- ============================================================================
-- VaultPoint Managed Accounts — custodial managed-trading product
-- ============================================================================
-- A materially different product from Signal Mode / Managed Mode: this is
-- VaultPoint holding and discretionarily trading a CLIENT'S capital in a
-- segregated sub-account, under a signed limited power of attorney, with a
-- profit split — not a user connecting their own broker account. Every
-- table here exists to enforce the flow's own stated acceptance criteria at
-- the database level, not just in application code:
--
-- "A client cannot reach step 6 (funding) without a completed, timestamped
--  signature on step 4" -> managed_accounts_funding_requires_authorization
-- KYC must clear before funding, same reasoning -> managed_accounts_active_requires_kyc
--
-- Tier names ('bronze'/'silver'/'gold') and the specific numeric bounds
-- below are placeholders — the spec's own PRD Section 6 (Managed Tier
-- definitions) was not available when writing this migration. Flagged
-- the same way ALERT_LIMITS_BY_TIER's numbers are in
-- src/lib/validations/alerts.ts: an assumption to revisit, not silently
-- treated as final.
-- ============================================================================

-- No existing admin-role concept anywhere in this schema — academy_videos'
-- migration explicitly notes the founder manages that table directly via
-- the Supabase Table Editor, not an app-level flag. The compliance
-- dashboard this product needs is an in-app internal tool, not a
-- Table-Editor workflow, so it needs a real gate.
alter table public.users add column is_admin boolean not null default false;
comment on column public.users.is_admin is
  'Gates access to internal-only routes/pages (the Managed Accounts compliance dashboard, audit export). Set directly via Table Editor — no self-service UI grants this, deliberately.';

create table public.disclosure_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  document_version text not null,
  viewed_at timestamptz not null default now(),
  -- Null until the client actually scrolls to the bottom (or the timed
  -- minimum view elapses) — the onboarding route's own gate for
  -- activating "Continue" checks this is set, not just that a row exists.
  scrolled_to_bottom_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.disclosure_views is
  'Audit log of every disclosure-screen view, per onboarding flow acceptance criteria ("Disclosure screen view is logged with a timestamp"). Append-only — no update/delete policy for any role.';

alter table public.disclosure_views enable row level security;
create policy "Users can view their own disclosure views"
  on public.disclosure_views for select
  using (auth.uid() = user_id);

create table public.client_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  -- Tied to the exact document version shown, per the flow's own
  -- acceptance criteria — never just "the current version," since the
  -- current version can change after this signature was captured.
  document_version text not null,
  document_url text not null,
  typed_legal_name text not null,
  signed_at timestamptz not null default now(),
  ip_address text,
  -- Only one method implemented: an explicit checkbox acknowledgment
  -- plus a typed legal name, captured alongside signed_at/ip_address as
  -- the audit trail. This is NOT a substitute for a real e-signature
  -- vendor (DocuSign, HelloSign) with independent legal enforceability
  -- guarantees — no such vendor is integrated anywhere in this
  -- codebase. Flagged as a real gap for Legal to weigh in on before
  -- this flow accepts real clients, not silently assumed sufficient.
  signature_method text not null default 'checkbox_and_typed_name'
    check (signature_method in ('checkbox_and_typed_name')),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.client_authorizations is
  'The signed limited power of attorney record. managed_accounts cannot reach pending_funding/active status without a row here — see managed_accounts_funding_requires_authorization.';

alter table public.client_authorizations enable row level security;
create policy "Users can view their own authorization records"
  on public.client_authorizations for select
  using (auth.uid() = user_id);

create table public.managed_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  -- Placeholder tier set — see this migration's header comment.
  tier text not null check (tier in ('bronze', 'silver', 'gold')),
  profit_split_pct numeric not null check (profit_split_pct > 0 and profit_split_pct <= 100),
  max_drawdown_pct numeric not null check (max_drawdown_pct > 0 and max_drawdown_pct <= 100),
  withdrawal_window_cadence text not null check (withdrawal_window_cadence in ('monthly', 'biweekly', 'on_demand')),
  next_withdrawal_window_date date,
  client_authorization_id uuid references public.client_authorizations(id),
  kyc_status text not null default 'pending' check (kyc_status in ('pending', 'verified', 'rejected')),
  kyc_verified_at timestamptz,
  -- Execution-capable brokers only — same scope Signal Mode's execution
  -- layer uses (see services/broker-sync/app/signal_execution.py's
  -- EXECUTABLE_BROKERS), for the same reason: these are the only two
  -- brokers this codebase has a place_order() implementation for.
  broker text not null check (broker in ('bybit', 'metatrader')),
  -- Deliberately NOT a broker_connections row: that table's own CHECK
  -- constraints and RLS model assume a user pasted their OWN
  -- read-only-by-default API key (see
  -- 20260718000000_add_signal_mode.sql's is_read_only invariant). A
  -- managed sub-account is VaultPoint-provisioned custodial
  -- infrastructure with a fundamentally different trust model, so it
  -- gets its own encrypted-credential columns, reusing the same
  -- AES-256-GCM pattern rather than overloading broker_connections'
  -- semantics.
  encrypted_api_key text,
  api_key_iv text,
  encrypted_api_secret text,
  api_secret_iv text,
  mt_login text,
  mt_server text,
  mt_platform text check (mt_platform is null or mt_platform in ('mt4', 'mt5')),
  encrypted_mt_password text,
  mt_password_iv text,
  metaapi_account_id text,
  metaapi_region text,
  status text not null default 'pending_kyc'
    check (status in ('pending_kyc', 'pending_authorization', 'pending_funding', 'active', 'closed')),
  starting_capital numeric,
  current_balance numeric,
  -- Flipped true by the (not-yet-built) terms-change process described
  -- in the compliance section — an existing client in a tier whose fee
  -- structure/split/risk policy changed must re-accept before their
  -- next distribution, never have it silently applied.
  requires_disclosure_reconfirmation boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint managed_accounts_funding_requires_authorization
    check (status not in ('pending_funding', 'active') or client_authorization_id is not null),
  constraint managed_accounts_active_requires_kyc
    check (status not in ('pending_funding', 'active') or kyc_status = 'verified')
);
comment on table public.managed_accounts is
  'One row per client managed account. The two CHECK constraints are the onboarding flow''s own acceptance criteria enforced at the DB level: no reaching funding/active without both a signed authorization AND verified KYC, regardless of what the application code path did or didn''t check.';
comment on column public.managed_accounts.kyc_status is
  'No KYC/sanctions-screening vendor is integrated anywhere in this codebase (Persona, Onfido, ComplyAdvantage, etc. — none exist here). This starts and stays ''pending'' until verified through whatever out-of-band or future-integrated process Legal/Compliance specifies; nothing in this codebase can set it to ''verified'' automatically yet.';

alter table public.managed_accounts enable row level security;
create policy "Users can view their own managed accounts"
  on public.managed_accounts for select
  using (auth.uid() = user_id);

create table public.managed_trades (
  id uuid primary key default gen_random_uuid(),
  managed_account_id uuid references public.managed_accounts(id) not null,
  symbol text not null,
  side text not null check (side in ('long', 'short')),
  size numeric not null,
  entry_price numeric not null,
  exit_price numeric,
  realized_pnl numeric,
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.managed_trades is
  'Read-only trade log shown on the client dashboard. Written only by whatever executes trades on the managed sub-account (not yet built — see Managed Accounts task list); no client insert/update/delete policy exists.';

alter table public.managed_trades enable row level security;
create policy "Users can view trades on their own managed accounts"
  on public.managed_trades for select
  using (
    exists (
      select 1 from public.managed_accounts
      where managed_accounts.id = managed_trades.managed_account_id
      and managed_accounts.user_id = auth.uid()
    )
  );

create table public.profit_distributions (
  id uuid primary key default gen_random_uuid(),
  managed_account_id uuid references public.managed_accounts(id) not null,
  period_start date not null,
  period_end date not null,
  gross_pnl numeric not null,
  client_share numeric not null,
  vaultpoint_share numeric not null,
  payout_method text,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'paid', 'failed')),
  statement_pdf_url text,
  requested_at timestamptz,
  confirmed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  constraint profit_distributions_one_per_account_per_period unique (managed_account_id, period_start, period_end)
);
comment on table public.profit_distributions is
  'One row per (managed_account, withdrawal period) — the unique constraint is the idempotency guard against double-processing the same withdrawal request, same pattern as profit_share_charges (20260718000003).';

alter table public.profit_distributions enable row level security;
create policy "Users can view distributions on their own managed accounts"
  on public.profit_distributions for select
  using (
    exists (
      select 1 from public.managed_accounts
      where managed_accounts.id = profit_distributions.managed_account_id
      and managed_accounts.user_id = auth.uid()
    )
  );
