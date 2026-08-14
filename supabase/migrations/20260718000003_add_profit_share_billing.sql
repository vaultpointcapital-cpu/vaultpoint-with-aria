-- ============================================================================
-- VaultPoint — Signal Mode Part 2: Profit-Share Billing
-- ============================================================================
-- Monthly true-up charge on Elite tier from Aria-attributed profit (Managed
-- Mode trades only — see signal_actions.initiated_by, 20260718000002). This
-- is a genuinely new charge, not a subscription renewal: the amount is
-- variable and only known after the fact, so it cannot be modeled as a
-- Stripe/Paystack recurring plan the way Pro/Elite's base subscription is.
--
-- profit_share_charges is the ledger AND the idempotency guard: the unique
-- constraint on (user_id, period_start, period_end) is what a billing job
-- checks before computing anything, and what stops a retried run (or two
-- overlapping cron triggers) from double-charging the same user for the
-- same month. Every outcome — including "profit was zero or negative, no
-- charge due" — gets a row, so a completed period always has exactly one
-- record regardless of which branch it went through.
-- ============================================================================

alter table public.subscriptions
  add column paystack_authorization_code text;

comment on column public.subscriptions.paystack_authorization_code is
  'Captured from Paystack''s charge.success webhook (data.authorization.authorization_code) — the only way to charge a Paystack customer off-session later, via /transaction/charge_authorization. Null for Stripe subscribers (Stripe charges off-session via the customer''s default payment method instead, no stored code needed) and for any Paystack subscriber who has not yet had a successful charge.';

create table public.profit_share_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) not null,
  period_start date not null,
  period_end date not null,
  attributed_profit numeric not null,
  fee_amount numeric not null,
  fee_currency text not null default 'usd',
  payment_provider text check (payment_provider in ('stripe', 'paystack')),
  provider_charge_id text,
  status text not null default 'pending' check (status in ('pending', 'charged', 'failed', 'skipped')),
  failure_reason text,
  created_at timestamptz not null default now(),
  constraint profit_share_charges_one_per_user_per_period unique (user_id, period_start, period_end)
);

comment on table public.profit_share_charges is
  'One row per (user, billing period), always — including periods with zero or negative attributed profit (status=skipped, fee_amount=0). The unique constraint on (user_id, period_start, period_end) is the idempotency guard a billing run checks before computing or charging anything.';
comment on column public.profit_share_charges.attributed_profit is
  'Sum of realized_pnl from signal_outcomes joined through signal_actions where initiated_by=''aria'', for this user and period — computed once and stored so the historical record does not change if later trades are (incorrectly) back-dated into an already-billed period.';
comment on column public.profit_share_charges.status is
  '''skipped'' means attributed_profit was <= 0 — no charge is ever attempted on a losing or breakeven period. ''failed'' means a charge was attempted (provider_charge_id may be null) and the provider rejected it — this does NOT retry automatically; see the billing run''s own retry-handling.';

alter table public.profit_share_charges enable row level security;

create policy "Users can view their own profit-share charges"
  on public.profit_share_charges for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for any client role — every row is
-- written by the billing run's service-role client only.
