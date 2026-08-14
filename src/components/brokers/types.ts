import type { BrokerConnection } from '@/types/database';

/**
 * What the connections screen actually needs — deliberately narrower than
 * BrokerConnection, which also carries encrypted_api_key/secret/passphrase
 * and the MT credential fields. There's no reason for those to travel
 * through a server-rendered page's props even though they're already
 * ciphertext, not plaintext.
 */
export type BrokerConnectionSummary = Pick<
  BrokerConnection,
  | 'id'
  | 'broker'
  | 'label'
  | 'is_read_only'
  | 'trade_execution_enabled'
  | 'managed_mode_enabled'
  | 'managed_mode_risk_pct'
  | 'managed_mode_daily_loss_limit_pct'
  | 'sync_status'
  | 'last_synced_at'
  | 'last_error'
  | 'health'
  | 'last_error_code'
  | 'closed_reason'
  | 'created_at'
>;
