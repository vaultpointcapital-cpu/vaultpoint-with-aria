-- ============================================================================
-- VaultPoint — Money & Currency Layer
-- ============================================================================
-- Exact-decimal storage for every money-bearing column, plus an fx_rates
-- table so historical net worth is reproducible from a snapshot row alone
-- (see portfolio_snapshots.fx_rates below). Pairs with src/lib/money.ts
-- (the only place TypeScript money arithmetic is allowed to live) and
-- src/lib/fx.ts / services/broker-sync/app/fx_service.py.
--
-- Column-name corrections vs. the original spec draft: positions uses
-- size/entry_price/mark_price (not quantity/current_price — renamed in
-- 20260717000001_reconcile_remaining_tables_with_live.sql), and
-- portfolio_snapshots uses total_net_worth (not net_worth). Both already
-- store unconstrained `numeric` (exact, arbitrary precision) — widening to
-- numeric(20,8) constrains precision uniformly for JSON-serialization
-- predictability, not because the DB itself had float drift (only the JS
-- layer does, which is what Money exists to fix).
--
-- savings_pods.currency and manual_assets.currency already exist (both
-- default 'USD') — not added here, only the numeric columns they sit
-- alongside are widened. Note: savings_pods defaults to 'USD' while this
-- migration's own pod_contributions.currency defaults to 'NGN' — a
-- pre-existing inconsistency in the source spec, not resolved here. Fixing
-- mislabeled existing rows needs a manual per-row audit (small beta
-- cohort), tracked as follow-up, not attempted in this migration — column
-- defaults are deliberately kept (not dropped) until that audit happens.
-- ============================================================================

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  currency text not null,
  rate_to_usd numeric(20,8) not null,
  -- 'openexchangerates' | 'binance' | 'manual' | 'cbn_official' | 'parallel_market'.
  -- The last two exist only for NGN's dual-rate handling — see the
  -- provisional-pending-founder-sign-off note on fx_service.py. Nigeria's
  -- official/CBN rate and the parallel/street rate diverge persistently;
  -- displaying the official rate alone materially understates NGN-priced
  -- holdings for VaultPoint's primary user base.
  source text not null,
  fetched_at timestamptz not null default now(),
  constraint fx_rates_rate_positive check (rate_to_usd > 0)
);

comment on table public.fx_rates is
  'Base-USD FX rate history. Every fetch is inserted (never updated) — audit trail plus the source data for portfolio_snapshots.fx_rates reproducibility.';

create index fx_rates_lookup_idx on public.fx_rates (currency, fetched_at desc);

alter table public.users
  add column display_currency text not null default 'USD';

comment on column public.users.display_currency is
  'Render-only preference (D6) — never changes what is stored, only how src/lib/utils/financial.ts formats it for this user.';

alter table public.positions
  alter column size type numeric(20,8),
  alter column entry_price type numeric(20,8),
  alter column mark_price type numeric(20,8),
  add column currency text not null default 'USD';

alter table public.manual_assets
  alter column value type numeric(20,8);

alter table public.savings_pods
  alter column target_amount type numeric(20,8),
  alter column current_amount type numeric(20,8);

alter table public.pod_contributions
  alter column amount type numeric(20,8),
  add column currency text not null default 'NGN';

alter table public.portfolio_snapshots
  alter column total_net_worth type numeric(20,8),
  add column currency text not null default 'USD',
  -- The reproducibility guarantee (D7): {"NGN": "0.00065", "USDT": "0.9998"}
  -- as used at write time. A historical read must call
  -- FxService.convertAt() against THIS map, never today's live rate.
  add column fx_rates jsonb not null default '{}'::jsonb,
  add column rates_stale boolean not null default false;

comment on column public.portfolio_snapshots.fx_rates is
  'Exact rate map used when this snapshot was computed — the reproducibility guarantee. Historical reads must use FxService.convertAt(), never a live rate.';

-- ============================================================================
-- contribute_to_pod: currency-safety only, no conversion. A pod's currency
-- is fixed (savings_pods.currency); a contribution must match it exactly or
-- is rejected — implicit conversion is explicitly out of scope (D3: no
-- amount without an explicit, checked currency). p_currency is optional so
-- an old caller that never sends it still gets the correct value stamped
-- (read from the pod itself, never trusted from the argument alone).
--
-- Signature changed (5 params, was 4) — dropped and recreated rather than
-- CREATE OR REPLACE, since adding a parameter changes the function's type
-- signature and CREATE OR REPLACE would otherwise create a second,
-- overloaded version instead of replacing the original.
-- ============================================================================
drop function if exists public.contribute_to_pod(uuid, uuid, numeric, text);

create function public.contribute_to_pod(
  p_pod_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_note text default null,
  p_currency text default null
)
returns table (
  contribution_id uuid,
  new_current_amount numeric
)
language plpgsql
security invoker
as $$
declare
  v_pod_status text;
  v_current_amount numeric;
  v_pod_currency text;
  v_contribution_id uuid;
  v_new_amount numeric;
begin
  select status, current_amount, currency into v_pod_status, v_current_amount, v_pod_currency
  from public.savings_pods
  where id = p_pod_id and user_id = p_user_id
  for update;

  if v_pod_status is null then
    raise exception 'Pod not found or access denied' using errcode = 'P0001';
  end if;

  if v_pod_status = 'archived' then
    raise exception 'Cannot contribute to an archived pod' using errcode = 'P0002';
  end if;

  if p_amount <= 0 then
    raise exception 'Contribution amount must be positive' using errcode = 'P0003';
  end if;

  if p_currency is not null and p_currency <> v_pod_currency then
    raise exception 'Contribution currency (%) does not match pod currency (%)', p_currency, v_pod_currency
      using errcode = 'P0005';
  end if;

  insert into public.pod_contributions (pod_id, user_id, amount, note, currency)
  values (p_pod_id, p_user_id, p_amount, p_note, v_pod_currency)
  returning id into v_contribution_id;

  v_new_amount := v_current_amount + p_amount;

  update public.savings_pods
  set current_amount = v_new_amount
  where id = p_pod_id;

  return query select v_contribution_id, v_new_amount;
end;
$$;

comment on function public.contribute_to_pod is
  'Atomically logs a pod contribution and updates the pod running total. Row-locked to prevent concurrent-write races. Rejects a contribution whose currency does not match the pod''s own currency (no implicit conversion) — added in 20260804000000_add_money_currency_layer.sql.';
