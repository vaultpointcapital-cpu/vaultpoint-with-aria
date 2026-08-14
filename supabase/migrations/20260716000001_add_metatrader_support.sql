-- ============================================================================
-- VaultPoint — Add MetaTrader (MT4/MT5) support
-- Sprint 1-2 hardening (MetaApi build-out)
-- ============================================================================
-- MT4/MT5 have no native REST API, so this bridges through MetaApi
-- (metaapi.cloud): a login/password/server on the broker's MT terminal,
-- not an api_key/api_secret pair. MetaApi itself also requires a
-- service-level API token (METAAPI_TOKEN, lives in the Python service's
-- env only) to provision a cloud terminal for that login before any
-- position data exists to read.
--
-- mt_login/mt_server/encrypted_mt_password are set at connection-creation
-- time by the Next.js app, same as every other broker's credentials.
-- metaapi_account_id/metaapi_region are NOT — they're populated later, by
-- the Python service, the first time it provisions this connection's
-- MetaApi cloud terminal. Hence: required-together check constraint on
-- the credential columns, but no such constraint on the MetaApi-assigned
-- ones — a fresh metatrader row legitimately has those as null until its
-- first poll cycle runs.
--
-- A MetaTrader row also has no api_key/api_secret at all — the original
-- migration made encrypted_api_key/encrypted_api_secret/their IVs
-- NOT NULL for every broker, which no longer holds. Relaxed here, with
-- the inverse check constraint added below so Bybit/Binance/KuCoin rows
-- still can't skip them.
-- ============================================================================

alter table public.broker_connections
  alter column encrypted_api_key drop not null,
  alter column encrypted_api_secret drop not null,
  alter column api_key_iv drop not null,
  alter column api_secret_iv drop not null;

alter table public.broker_connections
  add constraint broker_connections_non_metatrader_requires_api_credentials
  check (
    broker = 'metatrader'
    or (
      encrypted_api_key is not null
      and encrypted_api_secret is not null
      and api_key_iv is not null
      and api_secret_iv is not null
    )
  );

alter table public.broker_connections
  add column mt_login text,                    -- MT account number (broker's login id, not ours)
  add column mt_server text,                    -- broker's MT server name, e.g. "Exness-MT5Real8"
  add column mt_platform text check (mt_platform in ('mt4', 'mt5')),  -- MetaApi's account-creation call requires this
  add column encrypted_mt_password text,        -- AES-256-GCM ciphertext — should be the investor/read-only password
  add column mt_password_iv text,               -- IV for encrypted_mt_password
  add column metaapi_account_id text,           -- MetaApi's provisioned account resource id (uuid) — set by the poller, not at creation
  add column metaapi_region text;               -- MetaApi region for that resource, e.g. "london" — set alongside metaapi_account_id

comment on column public.broker_connections.encrypted_mt_password is
  'AES-256-GCM ciphertext for the MT account password. Should be the investor (read-only) password — VaultPoint has no way to enforce this the way it enforces is_read_only for API-key brokers, since MT has no scoped-permission credential concept.';
comment on column public.broker_connections.metaapi_account_id is
  'Set by the Python poller on first successful provisioning, not by the Next.js connection-creation flow — null on a brand new metatrader row is expected, not an error.';

alter table public.broker_connections
  add constraint broker_connections_metatrader_requires_mt_credentials
  check (
    broker <> 'metatrader'
    or (
      mt_login is not null
      and mt_server is not null
      and mt_platform is not null
      and encrypted_mt_password is not null
      and mt_password_iv is not null
    )
  );
