-- ============================================================================
-- VaultPoint — Add broker API passphrase support
-- Sprint 1-2 hardening (KuCoin build-out)
-- ============================================================================
-- KuCoin's signed Futures endpoints require a third credential beyond the
-- API key/secret every other supported broker uses: an API passphrase,
-- itself HMAC-signed on every request. broker_connections had nowhere to
-- store one. Nullable — Bybit/Binance/MetaTrader connections never set it;
-- the check constraint below only requires it for KuCoin rows.
-- ============================================================================

alter table public.broker_connections
  add column encrypted_api_passphrase text,  -- AES-256-GCM ciphertext, same scheme as encrypted_api_secret
  add column api_passphrase_iv text;         -- IV for encrypted_api_passphrase, unique per row

comment on column public.broker_connections.encrypted_api_passphrase is
  'AES-256-GCM ciphertext for the broker API passphrase. Only KuCoin currently requires one — null for Bybit, Binance, MetaTrader.';

alter table public.broker_connections
  add constraint broker_connections_kucoin_requires_passphrase
  check (
    broker <> 'kucoin'
    or (encrypted_api_passphrase is not null and api_passphrase_iv is not null)
  );
