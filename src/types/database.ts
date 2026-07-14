// ============================================================================
// Database types — hand-written to mirror supabase/migrations/*.sql exactly.
//
// Once the project is live on Supabase, run `npm run db:generate-types` to
// auto-generate this file from the real schema instead. Keeping it
// hand-written for now means it's reviewable without a live DB connection.
// ============================================================================

export type SubscriptionTier = 'free' | 'pro' | 'elite';
export type BrokerType = 'bybit' | 'binance' | 'kucoin' | 'metatrader';
export type SyncStatus = 'pending' | 'connected' | 'error' | 'disconnected';
export type PositionSide = 'long' | 'short' | 'buy' | 'sell';
export type AssetType = 'bank' | 'property' | 'other';
export type PodStatus = 'active' | 'completed' | 'archived';
export type AlertConditionType = 'price' | 'pnl_pct' | 'pnl_abs' | 'margin_pct';
export type AlertOperator = 'above' | 'below';
export type PaymentProvider = 'stripe' | 'paystack' | 'flutterwave';
export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialing';

export interface User {
  id: string;
  full_name: string | null;
  country_code: string | null;
  subscription_tier: SubscriptionTier;
  academy_student: boolean;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrokerConnection {
  id: string;
  user_id: string;
  broker: BrokerType;
  label: string;
  encrypted_api_key: string;
  encrypted_api_secret: string;
  api_key_iv: string;
  api_secret_iv: string;
  is_read_only: boolean;
  sync_status: SyncStatus;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Position {
  id: string;
  user_id: string;
  broker_connection_id: string;
  symbol: string;
  side: PositionSide;
  size: number;
  entry_price: number;
  mark_price: number | null;
  leverage: number;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  margin_used: number | null;
  opened_at: string | null;
  synced_at: string;
}

export interface PortfolioSnapshot {
  id: string;
  user_id: string;
  total_net_worth: number;
  crypto_value: number;
  forex_value: number;
  manual_assets_value: number;
  snapshot_date: string;
  created_at: string;
}

export interface ManualAsset {
  id: string;
  user_id: string;
  label: string;
  asset_type: AssetType;
  value: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface SavingsPod {
  id: string;
  user_id: string;
  name: string;
  target_amount: number;
  current_amount: number;
  currency: string;
  color: string;
  deadline: string | null;
  status: PodStatus;
  created_at: string;
  updated_at: string;
}

export interface PodContribution {
  id: string;
  pod_id: string;
  user_id: string;
  amount: number;
  note: string | null;
  created_at: string;
}

export interface Alert {
  id: string;
  user_id: string;
  symbol: string | null;
  condition_type: AlertConditionType;
  operator: AlertOperator;
  threshold: number;
  is_active: boolean;
  created_at: string;
}

export interface AlertHistoryEntry {
  id: string;
  alert_id: string;
  user_id: string;
  triggered_value: number;
  message: string;
  delivered_via: string[];
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  payment_provider: PaymentProvider;
  provider_subscription_id: string;
  tier: 'pro' | 'elite';
  status: SubscriptionStatus;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------------------------
// Supabase Database type — used to type the Supabase client generically.
// Mirrors the shape `supabase gen types typescript` would produce.
// ----------------------------------------------------------------------------
export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Partial<User> & { id: string };
        Update: Partial<User>;
      };
      broker_connections: {
        Row: BrokerConnection;
        Insert: Omit<BrokerConnection, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<BrokerConnection, 'id' | 'user_id'>>;
      };
      positions: {
        Row: Position;
        Insert: Omit<Position, 'id' | 'synced_at'>;
        Update: Partial<Omit<Position, 'id' | 'user_id'>>;
      };
      portfolio_snapshots: {
        Row: PortfolioSnapshot;
        Insert: Omit<PortfolioSnapshot, 'id' | 'created_at'>;
        Update: never; // append-only
      };
      manual_assets: {
        Row: ManualAsset;
        Insert: Omit<ManualAsset, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<ManualAsset, 'id' | 'user_id'>>;
      };
      savings_pods: {
        Row: SavingsPod;
        Insert: Omit<SavingsPod, 'id' | 'created_at' | 'updated_at' | 'current_amount'> & {
          current_amount?: number;
        };
        Update: Partial<Omit<SavingsPod, 'id' | 'user_id'>>;
      };
      pod_contributions: {
        Row: PodContribution;
        Insert: Omit<PodContribution, 'id' | 'created_at'>;
        Update: never; // append-only
      };
      alerts: {
        Row: Alert;
        Insert: Omit<Alert, 'id' | 'created_at'>;
        Update: Partial<Omit<Alert, 'id' | 'user_id'>>;
      };
      alert_history: {
        Row: AlertHistoryEntry;
        Insert: Omit<AlertHistoryEntry, 'id' | 'created_at'>;
        Update: never; // append-only
      };
      subscriptions: {
        Row: Subscription;
        Insert: Omit<Subscription, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Subscription, 'id' | 'user_id'>>;
      };
    };
  };
}
