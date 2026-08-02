-- ============================================================================
-- VaultPoint — Wallet (Deposit & Withdrawal)
-- ============================================================================
-- Isolated, ledger-first wallet module: its own tables, its own atomic RPC
-- (mirrors 20260617000001_atomic_pod_contribution.sql), its own RLS. Pods,
-- Alerts, broker-sync, and Aria never read or write these tables.
--
-- Three deposit/withdrawal rails: Paystack (NGN), Stripe (USD), and a
-- custodial crypto rail (USDT-TRC20) tracked via wallet_web3_deposit_addresses.
--
-- COMPLIANCE FLAG — read before enabling this in production:
-- The crypto rail here is a genuine custodial wallet (VaultPoint tracks a
-- held stablecoin balance and allows withdrawal to an external address),
-- which is a materially different and higher-risk feature than what
-- docs/web3-payments/prd-revival.md and wallet-integration-spec.md
-- recommended (that prior draft spec deliberately scoped crypto to
-- "convert to fiat immediately, never hold a balance, no crypto
-- withdrawal" specifically to stay clear of Virtual Asset Service Provider
-- (VASP) registration / AML-screening obligations that sit outside
-- VaultPoint's current SEC-scoped registration). This was a deliberate,
-- explicit product decision to build the broader/custodial version anyway
-- — but it means this schema and the routes built on top of it must not
-- be pointed at real money/real chains in production without a separate
-- legal/compliance review of VASP licensing exposure. Nothing here
-- implements real blockchain custody (no private key generation, no HSM);
-- deposit-address issuance and payout execution are placeholder adapters
-- (src/lib/wallet/web3-adapter.ts) pending a real custodian decision.
-- ============================================================================

create type wallet_txn_type as enum (
  'deposit', 'withdrawal', 'pod_funding', 'prop_funding', 'prop_payout',
  'fee', 'reversal'
);

create type wallet_txn_status as enum (
  'pending', 'completed', 'failed', 'reversed'
);

-- 'web3' added beyond the original PRD's list for the crypto rail (see
-- compliance flag above). 'flutterwave' kept for schema-level future-proofing
-- even though wallet routing (src/lib/wallet/routing.ts) doesn't use it yet.
create type wallet_provider as enum (
  'paystack', 'stripe', 'flutterwave', 'web3', 'internal'
);

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  currency text not null default 'NGN',
  balance_cached numeric(18,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, currency)
);

comment on table public.wallets is
  'One row per (user, currency). balance_cached is only ever written inside wallet_apply_transaction — never updated directly anywhere else.';

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id),
  user_id uuid not null references public.users(id),
  type wallet_txn_type not null,
  amount numeric(18,2) not null,
  currency text not null,
  status wallet_txn_status not null default 'pending',
  provider wallet_provider not null,
  provider_reference text unique,
  idempotency_key text unique not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.wallet_transactions is
  'Append-only wallet ledger. Only ever written via wallet_apply_transaction() — no direct insert policy for users, matching the subscriptions read-only-for-user pattern rather than pod_contributions user-insertable pattern.';

create index idx_wallet_txn_user on public.wallet_transactions (user_id, created_at desc);

create table public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  wallet_transaction_id uuid references public.wallet_transactions(id),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null,
  destination_type text not null check (destination_type in ('bank_account', 'mobile_money', 'crypto_address')),
  destination_details_encrypted text not null, -- AES-256-GCM, same module as broker keys (src/lib/encryption/broker-keys.ts)
  destination_details_iv text not null,
  status text not null default 'requested'
    check (status in ('requested', 'step_up_pending', 'approved', 'processing', 'paid', 'failed', 'rejected')),
  step_up_verified_at timestamptz,
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

comment on table public.withdrawal_requests is
  'One row per withdrawal attempt. Users may insert their own row directly (status forced to requested at insert) — every later transition (step_up_pending -> ... -> paid/failed/rejected) happens via service-role code only, after isStepUpApproved() succeeds.';

create index idx_withdrawal_requests_user on public.withdrawal_requests (user_id, requested_at desc);

-- One reusable deposit address per (user, chain) for the crypto rail. Not a
-- full HD-wallet address-per-payment scheme — see compliance flag above,
-- this is a placeholder until a real custodian is chosen.
create table public.wallet_web3_deposit_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  chain text not null default 'TRC20',
  address text not null,
  created_at timestamptz not null default now(),
  unique (user_id, chain)
);

comment on table public.wallet_web3_deposit_addresses is
  'Placeholder deposit-address pool for the crypto (USDT-TRC20) rail. Address generation in src/lib/wallet/web3-adapter.ts is explicitly not real on-chain custody yet.';

-- ============================================================================
-- Atomic RPC: mirrors contribute_to_pod's shape (row-locked, single
-- transaction, explicit errcodes). Unlike the original PRD draft, this
-- locks the wallet row with `for update` before reading/updating
-- balance_cached — without that lock, two concurrent calls (e.g. a webhook
-- retry racing the reconciliation job) could both read the same starting
-- balance before either writes, silently dropping one delta.
-- ============================================================================
create or replace function public.wallet_apply_transaction(
  p_user_id uuid,
  p_type wallet_txn_type,
  p_amount numeric,
  p_currency text,
  p_provider wallet_provider,
  p_provider_reference text,
  p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  transaction_id uuid,
  new_balance numeric
)
language plpgsql
security invoker
as $$
declare
  v_wallet_id uuid;
  v_txn_id uuid;
  v_delta numeric;
  v_current_balance numeric;
  v_new_balance numeric;
begin
  if p_amount <= 0 then
    raise exception 'Transaction amount must be positive' using errcode = 'P0003';
  end if;

  -- Find-or-create the wallet row, then immediately lock it for the rest of
  -- this transaction so concurrent callers serialize on this user+currency.
  select id into v_wallet_id
  from public.wallets
  where user_id = p_user_id and currency = p_currency
  for update;

  if v_wallet_id is null then
    insert into public.wallets (user_id, currency)
    values (p_user_id, p_currency)
    returning id into v_wallet_id;

    -- Re-select with the lock now that the row exists — the insert above
    -- doesn't itself need a lock (no other transaction can see an
    -- uncommitted row), but re-selecting keeps the rest of this function
    -- uniform regardless of which branch created the row.
    select id, balance_cached into v_wallet_id, v_current_balance
    from public.wallets
    where id = v_wallet_id
    for update;
  else
    select balance_cached into v_current_balance
    from public.wallets
    where id = v_wallet_id;
  end if;

  v_delta := case when p_type in ('deposit', 'reversal', 'prop_payout') then p_amount else -p_amount end;
  v_new_balance := v_current_balance + v_delta;

  if v_new_balance < 0 then
    raise exception 'Transaction would overdraw the wallet' using errcode = 'P0004';
  end if;

  insert into public.wallet_transactions
    (wallet_id, user_id, type, amount, currency, status, provider, provider_reference, idempotency_key, metadata)
  values
    (v_wallet_id, p_user_id, p_type, p_amount, p_currency, 'completed', p_provider, p_provider_reference, p_idempotency_key, p_metadata)
  on conflict (idempotency_key) do nothing
  returning id into v_txn_id;

  if v_txn_id is not null then
    update public.wallets
    set balance_cached = v_new_balance, updated_at = now()
    where id = v_wallet_id;
  else
    -- Idempotent replay of an already-applied transaction — return the
    -- wallet's actual current balance rather than the would-be new_balance,
    -- since no update happened.
    select balance_cached into v_new_balance from public.wallets where id = v_wallet_id;
  end if;

  return query select v_txn_id, v_new_balance;
end;
$$;

comment on function public.wallet_apply_transaction is
  'Atomically applies a wallet transaction and updates the cached balance. Row-locks the wallet for the duration of the call to prevent concurrent-write races (e.g. a webhook retry racing the nightly reconciliation job). Idempotent on (idempotency_key): a replayed call with the same key is a no-op that returns the current balance.';

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.wallet_web3_deposit_addresses enable row level security;

-- wallets / wallet_transactions: select-own only. No insert/update policy —
-- every write happens via wallet_apply_transaction(), called from
-- service-role webhook/route code, matching the subscriptions read-only
-- pattern rather than pod_contributions' user-insertable pattern.
create policy "Users can view their own wallets"
  on public.wallets for select
  using (auth.uid() = user_id);

create policy "Users can view their own wallet transactions"
  on public.wallet_transactions for select
  using (auth.uid() = user_id);

-- withdrawal_requests: users may view their own requests, and may create
-- one directly (status forced to 'requested' at insert) — every later
-- transition happens via service-role code only, same shape as
-- profit_distributions' insert-own policy
-- (20260719000000_add_managed_accounts_write_policies.sql).
create policy "Users can view their own withdrawal requests"
  on public.withdrawal_requests for select
  using (auth.uid() = user_id);

create policy "Users can request their own withdrawals"
  on public.withdrawal_requests for insert
  with check (auth.uid() = user_id and status = 'requested');

create policy "Users can view their own web3 deposit addresses"
  on public.wallet_web3_deposit_addresses for select
  using (auth.uid() = user_id);

-- ============================================================================
-- Extend billing_webhook_events to accept the new 'web3' provider, same
-- pattern as 20260721000000_add_flutterwave_to_webhook_events.sql.
-- ============================================================================
alter table public.billing_webhook_events
  drop constraint if exists billing_webhook_events_provider_check;

alter table public.billing_webhook_events
  add constraint billing_webhook_events_provider_check
  check (provider in ('stripe', 'paystack', 'flutterwave', 'web3'));
