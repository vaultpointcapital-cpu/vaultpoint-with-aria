-- ============================================================================
-- VaultPoint — Initial Schema Migration
-- Sprint 1-2: Foundation
-- ============================================================================
-- Run via: supabase db push
-- Or paste into Supabase SQL Editor.
--
-- Security note: every table has Row Level Security (RLS) enabled.
-- Users can only ever read/write their own rows. This is enforced at the
-- database level, not just the application level — defense in depth for
-- financial data.
-- ============================================================================

-- Extension for UUID generation
create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- users
-- Extends Supabase's built-in auth.users with VaultPoint-specific profile data.
-- We never duplicate auth fields (email, password) — those stay in auth.users.
-- ----------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  country_code text,                          -- ISO 3166-1 alpha-2, drives payment routing
  subscription_tier text not null default 'free'
    check (subscription_tier in ('free', 'pro', 'elite')),
  academy_student boolean not null default false,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is 'VaultPoint user profiles, 1:1 with auth.users';
comment on column public.users.country_code is 'Drives Stripe vs Paystack payment routing';

-- ----------------------------------------------------------------------------
-- broker_connections
-- Stores encrypted broker API keys. The key/secret columns hold AES-256-GCM
-- ciphertext, never plaintext. Encryption/decryption happens in
-- src/lib/encryption — never in the database, never in application logs.
-- ----------------------------------------------------------------------------
create table public.broker_connections (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  broker text not null
    check (broker in ('bybit', 'binance', 'kucoin', 'metatrader')),
  label text not null,                         -- user-friendly name, e.g. "Main Bybit"
  encrypted_api_key text not null,             -- AES-256-GCM ciphertext
  encrypted_api_secret text not null,          -- AES-256-GCM ciphertext
  api_key_iv text not null,                    -- IV for encrypted_api_key, unique per row
  api_secret_iv text not null,                 -- IV for encrypted_api_secret, unique per row
  is_read_only boolean not null default true,  -- enforced UX: platform never trades
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'connected', 'error', 'disconnected')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.broker_connections is 'Encrypted broker API credentials. Never log encrypted_api_key/secret values.';

create index idx_broker_connections_user_id on public.broker_connections(user_id);

-- ----------------------------------------------------------------------------
-- positions
-- Live positions pulled from broker APIs. Replaced/upserted on each poll
-- cycle (every 60s via the FastAPI scheduler) — not an append-only log.
-- ----------------------------------------------------------------------------
create table public.positions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  broker_connection_id uuid not null references public.broker_connections(id) on delete cascade,
  symbol text not null,                        -- e.g. "BTCUSDT", "EURUSD"
  side text not null check (side in ('long', 'short', 'buy', 'sell')),
  size numeric not null,
  entry_price numeric not null,
  mark_price numeric,
  leverage numeric default 1,
  unrealized_pnl numeric,
  unrealized_pnl_pct numeric,
  margin_used numeric,
  opened_at timestamptz,
  synced_at timestamptz not null default now()
);

comment on table public.positions is 'Live broker positions, upserted every 60s poll cycle.';

create index idx_positions_user_id on public.positions(user_id);
create index idx_positions_broker_connection_id on public.positions(broker_connection_id);
create unique index idx_positions_unique_open
  on public.positions(broker_connection_id, symbol, side);

-- ----------------------------------------------------------------------------
-- portfolio_snapshots
-- Daily net worth snapshot per user. Powers the net worth history chart.
-- Written once daily by a cron job (midnight UTC), not on every poll.
-- ----------------------------------------------------------------------------
create table public.portfolio_snapshots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  total_net_worth numeric not null,
  crypto_value numeric not null default 0,
  forex_value numeric not null default 0,
  manual_assets_value numeric not null default 0,
  snapshot_date date not null,
  created_at timestamptz not null default now()
);

comment on table public.portfolio_snapshots is 'One row per user per day. Powers net worth history chart.';

create unique index idx_portfolio_snapshots_user_date
  on public.portfolio_snapshots(user_id, snapshot_date);

-- ----------------------------------------------------------------------------
-- manual_assets
-- User-entered assets not pulled from any broker API (bank balance,
-- property, other holdings).
-- ----------------------------------------------------------------------------
create table public.manual_assets (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  label text not null,
  asset_type text not null
    check (asset_type in ('bank', 'property', 'other')),
  value numeric not null,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_manual_assets_user_id on public.manual_assets(user_id);

-- ----------------------------------------------------------------------------
-- savings_pods
-- Goal-based savings containers. Tier limits enforced in application logic
-- (Free: 1, Pro: 10, Elite: unlimited) — see src/lib/validations/pods.ts.
-- ----------------------------------------------------------------------------
create table public.savings_pods (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  target_amount numeric not null check (target_amount > 0),
  current_amount numeric not null default 0 check (current_amount >= 0),
  currency text not null default 'USD',
  color text not null default '#6C63FF',
  deadline date,
  status text not null default 'active'
    check (status in ('active', 'completed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_savings_pods_user_id on public.savings_pods(user_id);

-- ----------------------------------------------------------------------------
-- pod_contributions
-- Append-only contribution log per pod. current_amount on savings_pods is
-- kept in sync via the application layer transaction, not a trigger —
-- keeps the write path simple and testable.
-- ----------------------------------------------------------------------------
create table public.pod_contributions (
  id uuid primary key default uuid_generate_v4(),
  pod_id uuid not null references public.savings_pods(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);

create index idx_pod_contributions_pod_id on public.pod_contributions(pod_id);

-- ----------------------------------------------------------------------------
-- alerts
-- Alert rules per user. condition_type/operator/threshold drive simple
-- alerts at MVP; compound (cross-market) alerts are a Sprint 15+ extension
-- that will add a `conditions` jsonb column for chained AND/OR logic.
-- ----------------------------------------------------------------------------
create table public.alerts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  symbol text,                                 -- null for portfolio-wide alerts
  condition_type text not null
    check (condition_type in ('price', 'pnl_pct', 'pnl_abs', 'margin_pct')),
  operator text not null check (operator in ('above', 'below')),
  threshold numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_alerts_user_id on public.alerts(user_id);
create index idx_alerts_active on public.alerts(is_active) where is_active = true;

-- ----------------------------------------------------------------------------
-- alert_history
-- Fired alerts log. Append-only audit trail.
-- ----------------------------------------------------------------------------
create table public.alert_history (
  id uuid primary key default uuid_generate_v4(),
  alert_id uuid not null references public.alerts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  triggered_value numeric not null,
  message text not null,
  delivered_via text[] not null default '{}', -- e.g. {'email', 'push'}
  created_at timestamptz not null default now()
);

create index idx_alert_history_user_id on public.alert_history(user_id);

-- ----------------------------------------------------------------------------
-- subscriptions
-- Billing status per user. payment_provider tracks which gateway processed
-- the subscription (routing logic: NGN -> Paystack, else -> Stripe).
-- ----------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  payment_provider text not null
    check (payment_provider in ('stripe', 'paystack', 'flutterwave')),
  provider_subscription_id text not null,
  tier text not null check (tier in ('pro', 'elite')),
  status text not null
    check (status in ('active', 'past_due', 'cancelled', 'trialing')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_subscriptions_user_id on public.subscriptions(user_id);
create unique index idx_subscriptions_provider_id on public.subscriptions(provider_subscription_id);

-- ============================================================================
-- Row Level Security — every table, no exceptions.
-- Policy pattern: users can only access rows where user_id = auth.uid().
-- ============================================================================

alter table public.users enable row level security;
alter table public.broker_connections enable row level security;
alter table public.positions enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.manual_assets enable row level security;
alter table public.savings_pods enable row level security;
alter table public.pod_contributions enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_history enable row level security;
alter table public.subscriptions enable row level security;

-- users: can read/update own row only
create policy "users_select_own" on public.users
  for select using (auth.uid() = id);
create policy "users_update_own" on public.users
  for update using (auth.uid() = id);

-- broker_connections: full CRUD on own rows only
create policy "broker_connections_all_own" on public.broker_connections
  for all using (auth.uid() = user_id);

-- positions: read-only for users (written by service role from FastAPI poller)
create policy "positions_select_own" on public.positions
  for select using (auth.uid() = user_id);

-- portfolio_snapshots: read-only for users (written by cron via service role)
create policy "portfolio_snapshots_select_own" on public.portfolio_snapshots
  for select using (auth.uid() = user_id);

-- manual_assets: full CRUD on own rows
create policy "manual_assets_all_own" on public.manual_assets
  for all using (auth.uid() = user_id);

-- savings_pods: full CRUD on own rows
create policy "savings_pods_all_own" on public.savings_pods
  for all using (auth.uid() = user_id);

-- pod_contributions: insert + select own only (append-only, no edit/delete)
create policy "pod_contributions_select_own" on public.pod_contributions
  for select using (auth.uid() = user_id);
create policy "pod_contributions_insert_own" on public.pod_contributions
  for insert with check (auth.uid() = user_id);

-- alerts: full CRUD on own rows
create policy "alerts_all_own" on public.alerts
  for all using (auth.uid() = user_id);

-- alert_history: read-only for users (written by service role from alert engine)
create policy "alert_history_select_own" on public.alert_history
  for select using (auth.uid() = user_id);

-- subscriptions: read-only for users (written by service role from webhooks)
create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);

-- ============================================================================
-- Trigger: auto-create public.users row when a new auth.users row is created
-- ============================================================================
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================================
-- Trigger: auto-update updated_at columns
-- ============================================================================
create function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at before update on public.users
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.broker_connections
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.manual_assets
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.savings_pods
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.subscriptions
  for each row execute procedure public.set_updated_at();
