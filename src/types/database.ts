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
export type AlertConditionType = 'price' | 'pnl_pct' | 'pnl_abs' | 'margin_pct' | 'drawdown_pct';
export type AlertOperator = 'above' | 'below';
export type AriaChannel = 'telegram' | 'web';
export type AriaRole = 'user' | 'assistant';
export type AriaMessageType =
  | 'CHAT'
  | 'LOSS_WARNING'
  | 'PROFIT_ALERT'
  | 'BUY_SIGNAL'
  | 'PORTFOLIO_REVIEW'
  | 'MARKET_UPDATE'
  | 'IDLE_CHECK_IN'
  | 'RISK_CHECK'
  | 'COMMUNITY_NUDGE';
export type PaymentProvider = 'stripe' | 'paystack' | 'flutterwave';
export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialing';
export type MtPlatform = 'mt4' | 'mt5';
export type VideoProvider = 'youtube' | 'vimeo';
export type VideoType = 'long_form' | 'daily_short';
export type SignalDirection = 'long' | 'short';
export type SignalConfidence = 'low' | 'medium' | 'high';
export type SignalStatus = 'active' | 'closed' | 'invalidated';
export type SignalActionType = 'executed' | 'skipped' | 'ignored' | 'failed';
export type SignalActionInitiator = 'user' | 'aria';
export type SignalOutcomeResult = 'win' | 'loss' | 'breakeven';

// Every domain model below is a `type` alias, not an `interface` — a real
// TypeScript quirk, not a style choice: interfaces don't get an implicit
// index signature, so they fail `extends Record<string, unknown>` in
// conditional-type checks even though a structurally identical `type`
// literal passes. @supabase/supabase-js's SupabaseClient defaults its
// Schema type param via exactly that kind of conditional check against
// GenericTable's `Row: Record<string, unknown>` — so as interfaces, every
// Row/Insert/Update below silently failed it, and Schema fell back to
// `never` for the whole app. Confirmed via isolated repro before fixing:
// `interface X {a:string} extends Record<string,unknown>` -> false,
// `type X = {a:string} extends Record<string,unknown>` -> true.

export type User = {
  id: string;
  full_name: string | null;
  country_code: string | null;
  subscription_tier: SubscriptionTier;
  academy_student: boolean;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
};

export type BrokerConnection = {
  id: string;
  user_id: string;
  broker: BrokerType;
  label: string;
  // Bybit/Binance/KuCoin credentials — null for MetaTrader, which uses
  // mt_login/mt_server/encrypted_mt_password instead.
  encrypted_api_key: string | null;
  encrypted_api_secret: string | null;
  api_key_iv: string | null;
  api_secret_iv: string | null;
  encrypted_api_passphrase: string | null; // KuCoin only
  api_passphrase_iv: string | null;
  // MetaTrader credentials — null for every other broker.
  mt_login: string | null;
  mt_server: string | null;
  mt_platform: MtPlatform | null;
  encrypted_mt_password: string | null;
  mt_password_iv: string | null;
  // Set by the Python poller on first successful MetaApi provisioning —
  // null on a brand new metatrader row, not an error.
  metaapi_account_id: string | null;
  metaapi_region: string | null;
  is_read_only: boolean;
  // Signal Mode execution gate — DB CHECK-constrained to require
  // is_read_only = false. See
  // supabase/migrations/20260718000000_add_signal_mode.sql.
  trade_execution_enabled: boolean;
  // Managed Mode (autonomous execution) — DB CHECK-constrained to require
  // trade_execution_enabled=true plus every risk field below being set.
  // See supabase/migrations/20260718000002_add_managed_mode.sql.
  managed_mode_enabled: boolean;
  managed_mode_risk_pct: number | null;
  managed_mode_daily_loss_limit_pct: number | null;
  managed_mode_consented_at: string | null;
  sync_status: SyncStatus;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type Position = {
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
};

export type PortfolioSnapshot = {
  id: string;
  user_id: string;
  total_net_worth: number;
  crypto_value: number;
  forex_value: number;
  manual_assets_value: number;
  snapshot_date: string;
  created_at: string;
};

export type ManualAsset = {
  id: string;
  user_id: string;
  label: string;
  asset_type: AssetType;
  value: number;
  currency: string;
  created_at: string;
  updated_at: string;
};

export type SavingsPod = {
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
};

export type PodContribution = {
  id: string;
  pod_id: string;
  user_id: string;
  amount: number;
  note: string | null;
  created_at: string;
};

export type Alert = {
  id: string;
  user_id: string;
  symbol: string | null;
  condition_type: AlertConditionType;
  operator: AlertOperator;
  threshold: number;
  is_active: boolean;
  // Set by the Python Alert Engine each time this alert fires — null
  // means never triggered. See
  // supabase/migrations/20260717000005_add_alert_engine_cooldown_and_drawdown.sql
  last_triggered_at: string | null;
  created_at: string;
};

export type AlertHistoryEntry = {
  id: string;
  alert_id: string;
  user_id: string;
  triggered_value: number;
  message: string;
  delivered_via: string[];
  created_at: string;
};

export type Subscription = {
  id: string;
  user_id: string;
  // Nullable pre-checkout: a fresh row created for bookkeeping (or the
  // implicit "no subscriptions row = free tier" case handled in
  // getUserTier) has no provider attached yet.
  payment_provider: PaymentProvider | null;
  provider_subscription_id: string | null;
  // Stripe customer id / Paystack customer code — set on first successful
  // checkout, used to match later renewal/cancellation webhook events.
  provider_customer_id: string | null;
  // Captured from Paystack's charge.success webhook — the only way to
  // charge a Paystack customer off-session for profit-share billing. Null
  // for Stripe subscribers and for Paystack subscribers with no successful
  // charge yet. See 20260718000003_add_profit_share_billing.sql.
  paystack_authorization_code: string | null;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingWebhookEvent = {
  id: string;
  provider: 'stripe' | 'paystack';
  event_id: string;
  event_type: string;
  // Non-sensitive metadata only — never the raw webhook payload. See
  // supabase/migrations/20260717000000_reconcile_subscriptions_for_billing.sql
  metadata: Record<string, unknown>;
  processed_at: string;
};

export type ProfitShareStatus = 'pending' | 'charged' | 'failed' | 'skipped';

// Signal Mode Part 2 — one row per (user, billing period), always,
// including periods with no charge due. See
// supabase/migrations/20260718000003_add_profit_share_billing.sql.
export type ProfitShareCharge = {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  attributed_profit: number;
  fee_amount: number;
  fee_currency: string;
  payment_provider: PaymentProvider | null;
  provider_charge_id: string | null;
  status: ProfitShareStatus;
  failure_reason: string | null;
  created_at: string;
};

export type AcademyVideo = {
  id: string;
  title: string;
  description: string | null;
  video_provider: VideoProvider;
  video_id: string;
  video_type: VideoType;
  thumbnail_url: string | null;
  display_order: number;
  is_active: boolean;
  published_at: string;
  created_at: string;
};

// Not yet applied to any database (local, shadow, or live) — schema
// only, matching supabase/migrations/20260717000004_add_aria_conversations.sql.
// Typed here ahead of that migration landing so the Alert Engine's
// in-app delivery path and the (separately-built) Aria widget share one
// definition, not two that could drift.
export type AriaConversation = {
  id: string;
  user_id: string;
  channel: AriaChannel;
  role: AriaRole;
  content: string;
  message_type: AriaMessageType | null;
  created_at: string;
};

// Signal Mode. Matches supabase/migrations/20260718000000_add_signal_mode.sql
// and 20260718000001_add_failed_signal_action.sql exactly.

export type Signal = {
  id: string;
  pair: string;
  direction: SignalDirection;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_reward_ratio: number;
  rationale: string;
  confidence: SignalConfidence | null;
  min_tier: SubscriptionTier;
  status: SignalStatus;
  created_at: string;
  closed_at: string | null;
};

export type SignalAction = {
  id: string;
  signal_id: string;
  user_id: string;
  broker_connection_id: string | null;
  action: SignalActionType;
  executed_size: number | null;
  broker_order_id: string | null;
  // Populated only when action = 'failed' — see
  // 20260718000001_add_failed_signal_action.sql.
  failure_reason: string | null;
  // 'aria' only for Managed Mode autonomous executions — every row this
  // app's own API routes insert defaults to 'user'. See
  // 20260718000002_add_managed_mode.sql.
  initiated_by: SignalActionInitiator;
  created_at: string;
};

export type SignalOutcome = {
  id: string;
  signal_action_id: string;
  result: SignalOutcomeResult;
  realized_pnl: number;
  realized_r_multiple: number | null;
  closed_at: string;
};

// ----------------------------------------------------------------------------
// Supabase Database type — used to type the Supabase client generically.
// Mirrors the shape `supabase gen types typescript` would produce.
//
// Every table entry needs a Relationships array, and the schema needs
// Views/Functions keys, even when empty — @supabase/postgrest-js's
// GenericSchema constraint requires all of them structurally. Without
// them, `Database['public']` silently fails `extends GenericSchema` and
// every `.from()`/`.select()`/`.rpc()` call's return type collapses to
// `never` throughout the app (that was the root cause of the widespread
// "Property does not exist on type never" errors — not a bug in any
// individual route, but this file not satisfying the type this repo's
// installed @supabase/supabase-js version (^2.45.4, resolved to 2.110.x)
// actually requires).
// ----------------------------------------------------------------------------
export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Partial<User> & { id: string };
        Update: Partial<User>;
        Relationships: [];
      };
      broker_connections: {
        Row: BrokerConnection;
        // metaapi_account_id/region are set later by the Python poller
        // (see supabase/migrations/20260716000001_add_metatrader_support.sql),
        // last_synced_at/last_error start null — none of the four are set
        // by the Next.js connection-creation route. trade_execution_enabled
        // defaults to false at the DB level (see
        // 20260718000000_add_signal_mode.sql) — the connection-creation
        // route never sets it true; only the re-authorization route does.
        // managed_mode_* all default to false/null (20260718000002) — only
        // the Managed Mode opt-in route ever sets them.
        Insert: Omit<
          BrokerConnection,
          | 'id'
          | 'created_at'
          | 'updated_at'
          | 'metaapi_account_id'
          | 'metaapi_region'
          | 'last_synced_at'
          | 'last_error'
          | 'trade_execution_enabled'
          | 'managed_mode_enabled'
          | 'managed_mode_risk_pct'
          | 'managed_mode_daily_loss_limit_pct'
          | 'managed_mode_consented_at'
        > & {
          metaapi_account_id?: string | null;
          metaapi_region?: string | null;
          last_synced_at?: string | null;
          last_error?: string | null;
          trade_execution_enabled?: boolean;
          managed_mode_enabled?: boolean;
          managed_mode_risk_pct?: number | null;
          managed_mode_daily_loss_limit_pct?: number | null;
          managed_mode_consented_at?: string | null;
        };
        Update: Partial<Omit<BrokerConnection, 'id' | 'user_id'>>;
        Relationships: [];
      };
      positions: {
        Row: Position;
        Insert: Omit<Position, 'id' | 'synced_at'>;
        Update: Partial<Omit<Position, 'id' | 'user_id'>>;
        // The only embedded-select relation actually used in the app
        // (positions.select('*, broker_connections(...)')) — without real
        // metadata here, postgrest-js's type-level query parser can't
        // resolve the join and reports SelectQueryError at compile time,
        // even though it works fine at runtime (Postgrest infers real
        // relationships from the live DB's actual foreign keys).
        Relationships: [
          {
            foreignKeyName: 'positions_broker_connection_id_fkey';
            columns: ['broker_connection_id'];
            isOneToOne: false;
            referencedRelation: 'broker_connections';
            referencedColumns: ['id'];
          },
        ];
      };
      portfolio_snapshots: {
        Row: PortfolioSnapshot;
        Insert: Omit<PortfolioSnapshot, 'id' | 'created_at'>;
        Update: never; // append-only
        Relationships: [];
      };
      manual_assets: {
        Row: ManualAsset;
        Insert: Omit<ManualAsset, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<ManualAsset, 'id' | 'user_id'>>;
        Relationships: [];
      };
      savings_pods: {
        Row: SavingsPod;
        Insert: Omit<SavingsPod, 'id' | 'created_at' | 'updated_at' | 'current_amount'> & {
          current_amount?: number;
        };
        Update: Partial<Omit<SavingsPod, 'id' | 'user_id'>>;
        Relationships: [];
      };
      pod_contributions: {
        Row: PodContribution;
        Insert: Omit<PodContribution, 'id' | 'created_at'>;
        Update: never; // append-only
        Relationships: [];
      };
      alerts: {
        Row: Alert;
        // last_triggered_at is set only by the Python Alert Engine's own
        // update after firing — never by the Next.js create/edit routes.
        Insert: Omit<Alert, 'id' | 'created_at' | 'last_triggered_at'>;
        Update: Partial<Omit<Alert, 'id' | 'user_id'>>;
        Relationships: [];
      };
      alert_history: {
        Row: AlertHistoryEntry;
        Insert: Omit<AlertHistoryEntry, 'id' | 'created_at'>;
        Update: never; // append-only
        Relationships: [];
      };
      subscriptions: {
        Row: Subscription;
        // paystack_authorization_code starts null on every insert (the
        // checkout-initiation routes never have it yet) — only the
        // Paystack webhook's later UPDATE ever sets it, on charge.success.
        Insert: Omit<Subscription, 'id' | 'created_at' | 'updated_at' | 'paystack_authorization_code'> & {
          paystack_authorization_code?: string | null;
        };
        Update: Partial<Omit<Subscription, 'id' | 'user_id'>>;
        Relationships: [];
      };
      billing_webhook_events: {
        Row: BillingWebhookEvent;
        Insert: Omit<BillingWebhookEvent, 'id' | 'processed_at'>;
        Update: never; // append-only audit log
        Relationships: [];
      };
      // Written only by the profit-share billing run's service-role
      // client (src/lib/billing/profit-share.ts) — never by any
      // user-facing route. RLS grants users SELECT on their own rows only.
      profit_share_charges: {
        Row: ProfitShareCharge;
        Insert: Omit<ProfitShareCharge, 'id' | 'created_at'>;
        Update: never; // a period's outcome, once recorded, is final — rerun as a new period instead
        Relationships: [];
      };
      academy_videos: {
        Row: AcademyVideo;
        // No Insert/Update from the app — founder manages rows via the
        // Supabase Table Editor, not through this client. Typed as never
        // rather than omitted so an accidental .insert()/.update() call
        // fails at compile time instead of silently hitting RLS at runtime.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // Not yet applied to any database — see AriaConversation's comment.
      // Insert typed never here for the same reason as academy_videos:
      // this table is only ever written by the Python service's
      // service-role client (Alert Engine in-app delivery, and later the
      // Aria in-app workstream), never from Next.js — an accidental
      // client-side .insert() should fail at compile time.
      aria_conversations: {
        Row: AriaConversation;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // Written only by the founder/signal desk via service-role (no
      // Next.js insert/update path exists — see the Signal Mode
      // execution-layer summary). RLS grants `authenticated` SELECT only.
      signals: {
        Row: Signal;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // Append-only audit log, written by both the Next.js /api/signals/
      // [id]/skip route (RLS-permitted, user-scoped insert) and the Python
      // broker-sync service's service-role client (POST
      // /signals/{id}/execute, on both success and failure). No UPDATE/
      // DELETE policy exists — an action, once taken, is final.
      signal_actions: {
        Row: SignalAction;
        // initiated_by defaults to 'user' at the DB level (20260718000002)
        // — only app/managed_mode.py's autonomous-execution inserts ever
        // pass 'aria' explicitly.
        Insert: Omit<SignalAction, 'id' | 'created_at' | 'initiated_by'> & {
          initiated_by?: SignalActionInitiator;
        };
        Update: never;
        Relationships: [];
      };
      // Written only by the (not-yet-built) outcome-tracking job once a
      // signal closes — never by the Next.js app.
      signal_outcomes: {
        Row: SignalOutcome;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      // supabase/migrations/20260617000001_atomic_pod_contribution.sql
      contribute_to_pod: {
        Args: {
          p_pod_id: string;
          p_user_id: string;
          p_amount: number;
          p_note?: string | null;
        };
        Returns: {
          contribution_id: string;
          new_current_amount: number;
        }[];
      };
    };
  };
}
