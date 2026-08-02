-- ============================================================================
-- VaultPoint — Partner Offers v1 (Hantec Trader Instant Funding)
-- ============================================================================
-- Referral-only: VaultPoint never processes payment or takes custody of a
-- partner product. The only integration surface with the partner is a
-- state_token round-tripped through our own UI — see
-- src/app/api/offers/return/route.ts's comment for why this is NOT a
-- partner-initiated callback (Hantec has no webhook/redirect integration
-- with VaultPoint at all).
-- ============================================================================

create table public.partner_offers (
  id uuid primary key default gen_random_uuid(),
  partner_slug text not null,
  program text not null,
  account_size_usd int not null,
  price_from_usd numeric(10,2) not null,
  ref_url text not null,
  affiliate_code text,
  regions_allowed text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.partner_offers is
  'Referral catalog. VaultPoint earns affiliate commission on a purchase; never processes payment or takes custody. Readable by any authenticated user.';

create table public.partner_referrals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  offer_id uuid not null references public.partner_offers(id),
  state_token text not null unique,
  status text not null default 'clicked' check (status in ('clicked', 'returned', 'connected', 'expired')),
  clicked_at timestamptz not null default now(),
  returned_at timestamptz,
  connected_at timestamptz,
  broker_connection_id uuid references public.broker_connections(id),
  nudges_sent smallint not null default 0
);

comment on table public.partner_referrals is
  'Tracks a user''s click-through on a partner offer and, if they connect the resulting account, links it back. Written only via service-role code (POST /api/offers/:id/click, GET /api/offers/return, POST /api/brokers) — no user-writable columns.';

create index partner_referrals_user_status_idx on public.partner_referrals (user_id, status);
create index partner_referrals_status_clicked_idx on public.partner_referrals (status, clicked_at);

-- account_type='simulated' connections (e.g. a Hantec Instant Funding
-- account) are NOT the user's own money — see src/lib/utils/financial.ts's
-- excludeSimulatedPositions(), which every net-worth computation in this
-- codebase must filter through. Not toggleable in v1.
-- No `platform` column: broker_connections.mt_platform ('mt4'|'mt5') already
-- covers this for MetaTrader connections, which Hantec always is — a second
-- column storing the same fact would just be a second source of truth to
-- drift out of sync.
alter table public.broker_connections
  add column source text not null default 'manual' check (source in ('manual', 'partner_hantec')),
  add column account_type text not null default 'live' check (account_type in ('live', 'simulated'));

alter table public.partner_offers enable row level security;
alter table public.partner_referrals enable row level security;

create policy "Any authenticated user can view active partner offers"
  on public.partner_offers for select using (true);

create policy "Users can view their own partner referrals"
  on public.partner_referrals for select using (auth.uid() = user_id);
-- No insert/update policy for partner_referrals — click/return/connect all
-- write via a service-role client, same as wallet_transactions and
-- step_up_approvals.

-- Seed: Hantec Trader Instant Funding. affiliate_code confirmed against
-- Hantec's own Apply Code modal (§10.1 — resolved). regions_allowed below
-- is still a placeholder pending §10.2 — do not treat as launch-ready
-- until that's confirmed too:
insert into public.partner_offers
  (partner_slug, program, account_size_usd, price_from_usd, ref_url, affiliate_code, regions_allowed, active)
values
  ('hantec_trader', 'instant_funding', 2000, 39.00,
   'https://myhtrader.hmarkets.com/purchasechallenge?affiliateId=2769',
   'A5bm4qa68', -- CONFIRMED — §10.1: verified in Hantec's own Apply Code modal
   array['NG', 'GH', 'KE', 'ZA', 'GB', 'AE'], -- PLACEHOLDER — §10.2: get the authoritative excluded-jurisdiction list from Hantec's affiliate manager; Hantec gates at signup anyway, so this list is UX only, not a compliance control
   true);
