-- ============================================================================
-- VaultPoint — Valuation Contract
-- ============================================================================
-- Classification lives on the data (reality/liquidity/asset_class), not in
-- application code. Pairs with src/lib/valuation/ — the Holding contract,
-- the four HoldingProviders, and the single calculateNetWorthResult()
-- aggregator that replaces the six independent copies of
-- "fetch positions, filter simulated, sum" this schema used to require
-- (5 TS call sites + 1 unshared Python inline check).
--
-- positions.reality is trigger-maintained, never set by application code —
-- see sync_position_reality() below. No write path (Next.js API route or
-- the Python poller) can accidentally mark simulated equity as real.
-- ============================================================================

alter table public.manual_assets
  add column reality     text not null default 'real',
  add column liquidity   text not null default 'illiquid',
  add column asset_class text not null default 'other',
  add constraint manual_assets_reality_chk check (reality in ('real', 'simulated', 'pending')),
  add constraint manual_assets_liquidity_chk check (liquidity in ('liquid', 'semi_liquid', 'illiquid'));

comment on column public.manual_assets.reality is
  'Is this the user''s actual money? See src/lib/valuation/types.ts''s Reality type. User-entered, so self-reported, not verified.';

alter table public.positions
  add column reality     text not null default 'real',
  add column asset_class text not null default 'crypto',
  add constraint positions_reality_chk check (reality in ('real', 'simulated', 'pending'));

comment on column public.positions.reality is
  'Trigger-maintained from broker_connections.account_type — see sync_position_reality() below. Never set directly by application code, so no write path can mark simulated equity as real.';

alter table public.savings_pods
  add column liquidity text not null default 'semi_liquid';

-- ============================================================================
-- positions.reality is derived, not stored free-form (D6). Fires on insert
-- and whenever broker_connection_id changes — a position's connection is
-- immutable in practice after creation, so this covers the real lifecycle
-- without re-firing on every 60s mark_price refresh.
-- ============================================================================
create or replace function public.sync_position_reality() returns trigger as $$
begin
  select case when bc.account_type = 'simulated' then 'simulated' else 'real' end
    into new.reality
  from public.broker_connections bc
  where bc.id = new.broker_connection_id;
  return new;
end;
$$ language plpgsql;

create trigger positions_reality_trg
  before insert or update of broker_connection_id on public.positions
  for each row execute function public.sync_position_reality();

comment on function public.sync_position_reality is
  'Derives positions.reality from broker_connections.account_type at write time. If a connection is later reclassified, re-run an update of broker_connection_id (e.g. `update positions set broker_connection_id = broker_connection_id where ...`) on its positions to re-fire this.';

-- Backfill existing rows — the trigger only fires on future insert/update
-- of broker_connection_id, so pre-existing positions (including
-- already-synced Hantec/simulated ones from before this migration) need a
-- one-time correction, not just the column default. asset_class also
-- backfilled from the connection's broker — the blanket 'crypto' default
-- would otherwise mislabel every existing MetaTrader/forex position.
update public.positions p
set reality = case when bc.account_type = 'simulated' then 'simulated' else 'real' end,
    asset_class = case when bc.broker = 'metatrader' then 'fx' else 'crypto' end
from public.broker_connections bc
where bc.id = p.broker_connection_id;
