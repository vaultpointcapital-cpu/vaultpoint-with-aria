-- ============================================================================
-- Crypto Custody (Cobo) Integration
-- ============================================================================
-- Per crypto-custody-spec.pdf. Replaces the placeholder crypto rail
-- (src/lib/wallet/web3-adapter.ts's fake PLACEHOLDER-TRC20-{userId}
-- address and always-throwing initiateCryptoPayout(), wallet_web3_deposit_addresses
-- from 20260802000000_add_wallet.sql) with real custody infrastructure —
-- gated behind an application-level feature flag (COBO_INTEGRATION_ENABLED,
-- see src/lib/custody/provider.ts) that defaults OFF, since Cobo's real API
-- contract (endpoint shapes, request signing, webhook signature scheme)
-- cannot be verified from this environment and this table structure will
-- hold real user crypto once enabled.
--
-- wallet_web3_deposit_addresses is left untouched, not migrated or
-- dropped — custody_accounts supersedes it only for Cobo-backed accounts
-- once the flag is on; the placeholder path keeps using the old table
-- when it's off. A live data migration between the two is a separate,
-- riskier decision out of scope here.
--
-- Compliance note (carried forward, not resolved by this migration): see
-- 20260802000000_add_wallet.sql's own header for the still-open VASP/AML
-- licensing question this schema's custodial (balance-holding) model
-- raises. This spec's own Open Item #1 asks for legal sign-off before
-- integration begins — that is a business/legal process the user
-- retains control over separately from whether this code exists.
-- ============================================================================

create table public.custody_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  provider text not null default 'cobo' check (provider in ('cobo')),
  -- Cobo's own wallet/account identifier — an external reference only,
  -- never a private key or anything key-derived.
  provider_wallet_id text,
  deposit_address text,
  chain text not null,
  status text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, chain)
);

comment on table public.custody_accounts is
  'One row per (user, provider, chain) custody relationship. Supersedes wallet_web3_deposit_addresses for Cobo-backed accounts once COBO_INTEGRATION_ENABLED is true — see src/lib/wallet/web3-adapter.ts.';

create table public.custody_transactions (
  id uuid primary key default gen_random_uuid(),
  custody_account_id uuid not null references public.custody_accounts(id),
  direction text not null check (direction in ('deposit', 'withdrawal')),
  -- Crypto precision, not numeric(18,2) like the fiat-oriented tables in
  -- this schema — 10 fractional digits comfortably covers USDT/USDC (6
  -- decimals) with headroom.
  amount numeric(28, 10) not null check (amount > 0),
  -- Stablecoins only at launch — spec's own Open Item #4 recommendation
  -- (defer BTC/ETH to reduce custody/volatility complexity). A CHECK
  -- constraint, not application logic, so extending it later is a
  -- one-line migration, not a code change.
  asset text not null check (asset in ('USDT', 'USDC')),
  provider_tx_id text,
  -- 'pending_review': an outbound amount exceeding
  -- custody_settings.withdrawal_review_hold_threshold_usd (or the
  -- threshold being unset — fail-safe, not fail-open) sits here until an
  -- admin approves it. No Cobo withdrawal call fires for a
  -- pending_review row until that approval (spec 4.3.4's "multi-party
  -- approval on your side").
  status text not null default 'pending' check (status in ('pending', 'pending_review', 'confirmed', 'failed')),
  confirmed_at timestamptz,
  -- Links this custody event to the user-facing balance change. FKs to
  -- the REAL wallet ledger (wallet_transactions, 20260802000000_add_wallet.sql)
  -- — the spec's own schema sketch just said "your existing wallet
  -- ledger" without naming it; this is that table.
  ledger_entry_id uuid references public.wallet_transactions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.custody_transactions is
  'One row per custody-provider-side deposit/withdrawal event. ledger_entry_id links to the wallet_transactions row wallet_apply_transaction() wrote for the same event — never write wallet balances directly from this table''s consumers.';

create index idx_custody_transactions_account on public.custody_transactions (custody_account_id, created_at desc);
create index idx_custody_transactions_status on public.custody_transactions (status);

create table public.custody_settings (
  id int primary key default 1 check (id = 1), -- singleton, same convention as dispute_settings/payout_settings
  -- NULL is fail-safe: every crypto withdrawal requires manual approval
  -- until this is explicitly set, same posture as
  -- dispute_settings.tier3_max_authorization_ngn. USD-denominated since
  -- USDT/USDC are both ~$1-pegged, avoiding an FX-rate dependency for
  -- this comparison.
  withdrawal_review_hold_threshold_usd numeric(18, 2),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id)
);

insert into public.custody_settings (id) values (1);

comment on table public.custody_settings is
  'Singleton config for the crypto custody withdrawal review-hold threshold (spec Open Item #3 — deliberately separate from any fiat threshold, since crypto withdrawals are irreversible: no chargeback, no bank recall).';

create index idx_custody_accounts_user on public.custody_accounts (user_id);

alter table public.custody_accounts enable row level security;
alter table public.custody_transactions enable row level security;
alter table public.custody_settings enable row level security;

create policy "Users can view their own custody accounts"
  on public.custody_accounts for select
  using (auth.uid() = user_id);
create policy "Admins can view all custody accounts"
  on public.custody_accounts for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Users can view their own custody transactions"
  on public.custody_transactions for select
  using (
    exists (
      select 1 from public.custody_accounts
      where custody_accounts.id = custody_transactions.custody_account_id
      and custody_accounts.user_id = auth.uid()
    )
  );
create policy "Admins can view all custody transactions"
  on public.custody_transactions for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

create policy "Admins can view custody settings"
  on public.custody_settings for select
  using (exists (select 1 from public.users where users.id = auth.uid() and users.is_admin = true));

-- No client insert/update/delete policy on any of the three tables, for
-- any role — every write goes through a route's service-role client or
-- the CustodyProvider adapter, same rule as every other money table in
-- this schema.

create trigger set_updated_at before update on public.custody_accounts
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.custody_transactions
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.custody_settings
  for each row execute procedure public.set_updated_at();
