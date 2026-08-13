-- ============================================================================
-- VaultPoint — Wallet KYC Tiering
-- ============================================================================
-- Resolves the placeholder noted in src/lib/wallet/limits.ts ("PRD open
-- question #3 — no real figures given yet... add a rolling cap here, not in
-- a route, when real figures land"): a KYC-tier gate on deposit/withdrawal,
-- per the wallet PRD's §9 addendum.
--
-- NAMING COLLISION NOTE: public.kyc_verifications already exists
-- (20260724000003_add_kyc_verifications.sql) as a different, incompatible,
-- mature system — identity verification for Managed Accounts/Managed
-- Traders (managed_account_id/managed_trader_id subject, kyc_vendor enum
-- 'verifyme'/'onfido', single writer src/lib/kyc/verification-state.ts).
-- This migration deliberately does NOT touch or extend that table. It adds
-- a fully isolated table, wallet_kyc_tier_verifications, with its own
-- writer (src/lib/kyc/tier-state.ts) — same "isolated module, no shared
-- blast radius" convention already used throughout this codebase (Pods vs.
-- wallet vs. managed accounts).
-- ============================================================================

create type kyc_tier as enum ('tier0', 'tier1', 'tier2');

alter table public.users
  add column kyc_tier kyc_tier not null default 'tier0',
  add column kyc_tier_verified_at timestamptz;

comment on column public.users.kyc_tier is
  'Wallet KYC tier gate, independent of managed_accounts.kyc_status. Only ever written by src/lib/kyc/tier-state.ts.';

-- Reference/lookup table — figures kept here, not hardcoded in application
-- code, so they can be tuned without a deploy (per PRD §9). Readable by any
-- authenticated user (e.g. to render "upgrade to unlock X" copy); written
-- only by this migration's seed data below.
create table public.kyc_tier_limits (
  tier kyc_tier primary key,
  max_single_deposit numeric(18,2),      -- null = unlimited
  max_monthly_deposit numeric(18,2),     -- null = unlimited, rolling 30 days
  withdrawals_allowed boolean not null default false,
  max_single_withdrawal numeric(18,2),
  max_monthly_withdrawal numeric(18,2)
);

comment on table public.kyc_tier_limits is
  'PRD §9 tier figures. NULL means unlimited for that field. These are NGN-denominated (the PRD gives only Naira figures) — wallet_check_kyc_limit only enforces the numeric caps when p_currency = ''NGN''; USD/USDT deposits/withdrawals still get the withdrawals_allowed gate but not the numeric caps, same "no real figures yet, don''t invent them" stance as src/lib/wallet/limits.ts.';

alter table public.kyc_tier_limits enable row level security;

create policy "Any authenticated user can view tier limits"
  on public.kyc_tier_limits for select
  using (true);

insert into public.kyc_tier_limits
  (tier, max_single_deposit, max_monthly_deposit, withdrawals_allowed, max_single_withdrawal, max_monthly_withdrawal)
values
  ('tier0', 0,     0,      false, 0,    0),
  ('tier1', 50000, 200000, false, 0,    0),
  ('tier2', null,  null,   true,  null, null);

-- Isolated tier-verification-attempt audit trail. User-scoped only — no
-- managed_account_id/managed_trader_id concept, no shared writer with
-- public.kyc_verifications.
create type wallet_kyc_tier_status as enum ('pending', 'processing', 'verified', 'rejected', 'error');

create table public.wallet_kyc_tier_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tier kyc_tier not null,                 -- the tier this attempt is upgrading to
  method text not null check (method in ('phone_email', 'bvn_nin_liveness')),
  provider text not null check (provider in ('internal', 'smileid', 'youverify', 'stub')),
  status wallet_kyc_tier_status not null default 'pending',
  vendor_ref text,
  -- Normalized/scrubbed only — no raw BVN/NIN, no selfie image, no vendor
  -- payload. Scrubbing is the writer module's (tier-state.ts) job, same
  -- disclaimer as kyc_verifications.result_summary.
  result_summary jsonb,
  failure_reason text,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.wallet_kyc_tier_verifications is
  'Audit trail of wallet KYC tier-upgrade attempts. Single writer: src/lib/kyc/tier-state.ts, called only from /api/kyc/* route handlers. No client insert/update policy.';

-- One in-flight attempt per user at a time, regardless of tier.
create unique index one_active_wallet_kyc_tier_verification_per_user
  on public.wallet_kyc_tier_verifications (user_id)
  where status in ('pending', 'processing');

create index wallet_kyc_tier_verifications_user_idx
  on public.wallet_kyc_tier_verifications (user_id, created_at desc);

alter table public.wallet_kyc_tier_verifications enable row level security;

create policy "Users can view their own tier verification attempts"
  on public.wallet_kyc_tier_verifications for select
  using (auth.uid() = user_id);
-- No insert/update policy — writes are service-role only, via tier-state.ts.

-- ============================================================================
-- wallet_check_kyc_limit — gate called by /api/wallet/deposit/initiate and
-- /api/wallet/withdraw/request before any provider call. p_currency is added
-- beyond the PRD's literal (p_user_id, p_type, p_amount) signature because
-- kyc_tier_limits' numeric caps are NGN-only (see table comment above);
-- withdrawals_allowed still gates every currency. Complements (does not
-- replace) checkWalletLimit()'s static per-currency min/max in
-- src/lib/wallet/limits.ts.
--
-- Rolling 30-day window chosen over calendar-month for max_monthly_* — the
-- PRD says "monthly" without specifying calendar vs. rolling; a rolling
-- window avoids month-boundary edge cases and needs no cron reset.
-- ============================================================================
create or replace function public.wallet_check_kyc_limit(
  p_user_id uuid,
  p_type text,             -- 'deposit' | 'withdrawal'
  p_amount numeric,
  p_currency text default 'NGN'
)
returns table (allowed boolean, reason_code text, message text)
language plpgsql
security invoker
as $$
declare
  v_tier kyc_tier;
  v_limits record;
  v_monthly_total numeric;
begin
  if p_type not in ('deposit', 'withdrawal') then
    raise exception 'wallet_check_kyc_limit: invalid p_type %', p_type using errcode = 'P0001';
  end if;

  select kyc_tier into v_tier from public.users where id = p_user_id;
  if v_tier is null then
    v_tier := 'tier0';
  end if;

  select * into v_limits from public.kyc_tier_limits where tier = v_tier;

  if p_type = 'withdrawal' and not v_limits.withdrawals_allowed then
    return query select false, 'withdrawals_not_allowed_for_tier',
      'Withdrawals are not available at your current KYC tier. Verify your identity to unlock withdrawals.';
    return;
  end if;

  if p_currency = 'NGN' then
    if p_type = 'deposit' and v_limits.max_single_deposit is not null and p_amount > v_limits.max_single_deposit then
      return query select false, 'single_deposit_limit_exceeded',
        format('Maximum single deposit for your tier is %s NGN.', v_limits.max_single_deposit);
      return;
    end if;

    if p_type = 'withdrawal' and v_limits.max_single_withdrawal is not null and p_amount > v_limits.max_single_withdrawal then
      return query select false, 'single_withdrawal_limit_exceeded',
        format('Maximum single withdrawal for your tier is %s NGN.', v_limits.max_single_withdrawal);
      return;
    end if;

    if p_type = 'deposit' and v_limits.max_monthly_deposit is not null then
      select coalesce(sum(amount), 0) into v_monthly_total
        from public.wallet_transactions
        where user_id = p_user_id and type = 'deposit' and status = 'completed'
          and currency = 'NGN' and created_at >= now() - interval '30 days';
      if v_monthly_total + p_amount > v_limits.max_monthly_deposit then
        return query select false, 'monthly_deposit_limit_exceeded',
          format('This would exceed your rolling 30-day deposit limit of %s NGN.', v_limits.max_monthly_deposit);
        return;
      end if;
    end if;

    if p_type = 'withdrawal' and v_limits.max_monthly_withdrawal is not null then
      select coalesce(sum(amount), 0) into v_monthly_total
        from public.wallet_transactions
        where user_id = p_user_id and type = 'withdrawal' and status = 'completed'
          and currency = 'NGN' and created_at >= now() - interval '30 days';
      if v_monthly_total + p_amount > v_limits.max_monthly_withdrawal then
        return query select false, 'monthly_withdrawal_limit_exceeded',
          format('This would exceed your rolling 30-day withdrawal limit of %s NGN.', v_limits.max_monthly_withdrawal);
        return;
      end if;
    end if;
  end if;

  return query select true, null::text, null::text;
end;
$$;

comment on function public.wallet_check_kyc_limit is
  'Gate checked by /api/wallet/deposit/initiate and /api/wallet/withdraw/request before any provider call. Called via createServiceClient() despite security invoker, matching how wallet_apply_transaction is always called through the service client.';
