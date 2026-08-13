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
// Connection Health & Data Freshness — coexists with SyncStatus, it does
// not replace it. sync_status stays a derived, backward-compatible view
// (healthy/pending->connected/pending, degraded/stale/auth_failed->error,
// closed->disconnected) maintained by the Python poller; health is the
// richer, authoritative signal for freshness-aware consumers (alert
// suppression, Aria, the dashboard badge). See
// supabase/migrations/20260806000000_add_connection_health.sql.
export type HealthState = 'pending' | 'healthy' | 'degraded' | 'stale' | 'auth_failed' | 'closed';
export type ClosedReason = 'user_removed' | 'provider_closed' | 'prop_breached';
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
// Aria Pantheon. Matches supabase/migrations/20260813000000_add_aria_findings.sql
// as extended by 20260814000003_extend_aria_findings_for_scanner_alerts.sql
// (adds 'aria_scanner'/'trade_setup_alert' for the Decision Gate's
// manual-account alert durability path — see that migration's comment for
// why those findings are always severity='caution', never proactive-eligible).
export type AriaFindingSourceAgent =
  | 'argus'
  | 'plutus'
  | 'hermes'
  | 'mnemosyne'
  | 'nike'
  | 'themis'
  | 'aria_scanner';
export type AriaFindingType =
  | 'loss_warning'
  | 'profit_alert'
  | 'buy_signal'
  | 'portfolio_review'
  | 'market_update'
  | 'risk_check'
  | 'community_nudge'
  | 'trade_setup_alert';
export type AriaFindingSeverity = 'info' | 'caution' | 'warning' | 'critical';
export type AriaFindingStatus = 'new' | 'acknowledged' | 'delivered' | 'dismissed' | 'expired';
// Per-position dedup state, supabase/migrations/20260813000001_add_positions_pantheon_severity.sql.
export type PantheonSeverityBucket = 'none' | 'caution' | 'warning' | 'critical';
// Tier Contract — What Each Tier Promises. tier_name is DELIBERATELY its
// own vocabulary, not SubscriptionTier and not managed_accounts.tier — see
// supabase/migrations/20260815000002_add_tier_contracts.sql's header
// comment for why these three tier concepts are not unified.
export type TierName = 'free' | 'pro' | 'elite' | 'managed';
export type TierContractStatus = 'active' | 'superseded';
export type CommitmentType = 'feature_access' | 'outcome' | 'sla' | 'limit';
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
  // Gates internal-only routes (Managed Accounts compliance dashboard,
  // audit export) — set directly via Table Editor, no self-service UI
  // grants this. See 20260718000004_add_managed_accounts.sql.
  is_admin: boolean;
  // See 20260720000000_add_email_confirmation_retry_flag.sql — signup's
  // own Resend send (src/app/api/auth/signup/route.ts) sets this true on
  // failure; POST /api/auth/resend-confirmation clears it on retry.
  confirmation_email_pending_retry: boolean;
  // Set once, the first time GET /auth/callback confirms this user's
  // email — null means the welcome email has never been sent.
  welcome_email_sent_at: string | null;
  // Money & Currency Layer — render-only (D6). Never changes what's
  // stored; only src/lib/utils/financial.ts's display formatting reads it.
  display_currency: string;
  // Wallet KYC tier gate (independent of managed_accounts.kyc_status).
  // Only ever written by src/lib/kyc/tier-state.ts. See
  // 20260814000000_add_wallet_kyc_tiering.sql.
  kyc_tier: KycTier;
  kyc_tier_verified_at: string | null;
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
  // Connection Health & Data Freshness — health is authoritative;
  // sync_status above is kept as a derived view, see the HealthState
  // comment. next_attempt_at drives poll_all_connections's query
  // directly (broker_connections_poll_idx) — backoff on repeated
  // failures means a connection can go multiple cycles without being
  // polled at all.
  health: HealthState;
  last_success_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  next_attempt_at: string;
  closed_at: string | null;
  closed_reason: ClosedReason | null;
  // Which bad health state (if any) a notification has already been sent
  // for — null once health is healthy/pending again. Prevents both
  // spamming on a degraded->stale->degraded flap and a recovery notice
  // firing when no failure notice ever went out.
  notified_health_state: HealthState | null;
  // Partner Offers v1 — 'partner_hantec' + 'simulated' together mean this
  // connection tracks a prop-firm challenge balance, not the user's own
  // money. Drives positions.reality via a DB trigger — see the Valuation
  // Contract, supabase/migrations/20260805000000_add_valuation_contract.sql.
  source: 'manual' | 'partner_hantec';
  account_type: 'live' | 'simulated';
  created_at: string;
  updated_at: string;
};

// Connection Health & Data Freshness — append-only transition audit log,
// same shape as step_up_audit_log. from_health is null on the very first
// event (pending -> whatever the first sync outcome produces).
export type ConnectionHealthEvent = {
  id: string;
  connection_id: string;
  from_health: HealthState | null;
  to_health: HealthState;
  error_code: string | null;
  created_at: string;
};

export type PartnerReferralStatus = 'clicked' | 'returned' | 'connected' | 'expired';

export type PartnerOffer = {
  id: string;
  partner_slug: string;
  program: string;
  account_size_usd: number;
  price_from_usd: number;
  ref_url: string;
  affiliate_code: string | null;
  regions_allowed: string[];
  active: boolean;
  created_at: string;
};

export type PartnerReferral = {
  id: string;
  user_id: string;
  offer_id: string;
  state_token: string;
  status: PartnerReferralStatus;
  clicked_at: string;
  returned_at: string | null;
  connected_at: string | null;
  broker_connection_id: string | null;
  nudges_sent: number;
};

// Valuation Contract — src/lib/valuation/types.ts. Reality/Liquidity are
// DB-level CHECK-constrained string unions; keep these in sync with the
// migration's constraints, not just the TS side.
export type Reality = 'real' | 'simulated' | 'pending';
export type Liquidity = 'liquid' | 'semi_liquid' | 'illiquid';
export type ValuationAssetClass =
  | 'crypto'
  | 'fx'
  | 'equity'
  | 'cash'
  | 'savings_pod'
  | 'property'
  | 'prop_account'
  | 'other';

export type Position = {
  id: string;
  user_id: string;
  broker_connection_id: string;
  symbol: string;
  side: PositionSide;
  size: number;
  entry_price: number;
  mark_price: number | null;
  // Quote currency for entry_price/mark_price — added by the Money &
  // Currency Layer. size itself has no currency (it's a quantity).
  currency: string;
  // Trigger-maintained from broker_connections.account_type (Valuation
  // Contract) — never set by application code. See
  // supabase/migrations/20260805000000_add_valuation_contract.sql's
  // sync_position_reality().
  reality: Reality;
  asset_class: ValuationAssetClass;
  leverage: number;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  margin_used: number | null;
  opened_at: string | null;
  synced_at: string;
  // Aria Pantheon dedup state — never set by TS code, only by
  // services/broker-sync/app/pantheon/argus.py|plutus.py. See
  // supabase/migrations/20260813000001_add_positions_pantheon_severity.sql.
  argus_last_severity: PantheonSeverityBucket;
  plutus_last_severity: PantheonSeverityBucket;
};

export type PortfolioSnapshot = {
  id: string;
  user_id: string;
  total_net_worth: number;
  crypto_value: number;
  forex_value: number;
  manual_assets_value: number;
  // Always 'USD' today — the daily snapshot job (sync_service.py) converts
  // every currency to USD before summing. currency/fx_rates/rates_stale
  // added by the Money & Currency Layer.
  currency: string;
  // The exact rate map used at write time — the D7 reproducibility
  // guarantee. A historical read must call FxService.convertAt() against
  // this, never a live rate.
  fx_rates: Record<string, string>;
  rates_stale: boolean;
  // Connection Health & Data Freshness — true if any contributing
  // connection's health was not 'healthy' at snapshot time.
  // degraded_sources never fabricates a clean number; it names exactly
  // which broker/label contributed stale data.
  degraded: boolean;
  degraded_sources: Array<{ broker: BrokerType; label: string }>;
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
  // Valuation Contract — user-entered, so provenance is always
  // 'user_entered' (not stored; derived by ManualAssetProvider). reality
  // defaults 'real' (self-reported, not verified — a manual_assets row is
  // never trigger-derived the way positions.reality is).
  reality: Reality;
  liquidity: Liquidity;
  asset_class: ValuationAssetClass;
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
  // Informational reminder cadence only — no automated transfer is ever
  // scheduled from this value. See the migration comment on this column.
  funding_reminder: 'weekly' | 'biweekly' | 'monthly' | null;
  // Valuation Contract — defaults 'semi_liquid'.
  liquidity: Liquidity;
  status: PodStatus;
  created_at: string;
  updated_at: string;
};

export type PodContribution = {
  id: string;
  pod_id: string;
  user_id: string;
  amount: number;
  // Always equal to the parent pod's own currency — contribute_to_pod()
  // rejects a mismatched p_currency rather than converting. Added by the
  // Money & Currency Layer.
  currency: string;
  note: string | null;
  created_at: string;
};

export type FxRate = {
  id: string;
  currency: string;
  rate_to_usd: number;
  source: 'openexchangerates' | 'binance' | 'manual' | 'cbn_official' | 'parallel_market';
  fetched_at: string;
};

export type WalletTxnType =
  | 'deposit'
  | 'withdrawal'
  | 'pod_funding'
  | 'prop_funding'
  | 'prop_payout'
  | 'fee'
  | 'reversal';

export type WalletTxnStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export type WalletProviderEnum = 'paystack' | 'stripe' | 'flutterwave' | 'web3' | 'internal';

export type Wallet = {
  id: string;
  user_id: string;
  currency: string;
  balance_cached: number;
  updated_at: string;
};

export type WalletTransaction = {
  id: string;
  wallet_id: string;
  user_id: string;
  type: WalletTxnType;
  amount: number;
  currency: string;
  status: WalletTxnStatus;
  provider: WalletProviderEnum;
  provider_reference: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type WithdrawalRequestStatus =
  | 'requested'
  | 'step_up_pending'
  | 'approved'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'rejected';

export type WithdrawalRequest = {
  id: string;
  user_id: string;
  wallet_transaction_id: string | null;
  amount: number;
  currency: string;
  destination_type: 'bank_account' | 'mobile_money' | 'crypto_address';
  destination_details_encrypted: string;
  destination_details_iv: string;
  status: WithdrawalRequestStatus;
  step_up_verified_at: string | null;
  requested_at: string;
  processed_at: string | null;
};

export type WalletWeb3DepositAddress = {
  id: string;
  user_id: string;
  chain: string;
  address: string;
  created_at: string;
};

// Wallet KYC Tiering — see 20260814000000_add_wallet_kyc_tiering.sql.
// Deliberately separate from KycVendor/KycVerification above, which is a
// different, incompatible system (Managed Accounts/Trader identity).
export type KycTier = 'tier0' | 'tier1' | 'tier2';

export type KycTierLimits = {
  tier: KycTier;
  max_single_deposit: number | null;
  max_monthly_deposit: number | null;
  withdrawals_allowed: boolean;
  max_single_withdrawal: number | null;
  max_monthly_withdrawal: number | null;
};

export type WalletKycTierVerificationStatus = 'pending' | 'processing' | 'verified' | 'rejected' | 'error';

export type WalletKycTierVerification = {
  id: string;
  user_id: string;
  tier: KycTier;
  method: 'phone_email' | 'bvn_nin_liveness';
  provider: 'internal' | 'smileid' | 'youverify' | 'stub';
  status: WalletKycTierVerificationStatus;
  vendor_ref: string | null;
  result_summary: Record<string, unknown> | null;
  failure_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

// Value Ledger — see 20260815000000_add_value_ledger.sql. Isolated
// module: written only via value_ledger_apply_event() (events) or the
// nightly rollup job (rollups), read only by service-role contexts (the
// admin dashboard, the rollup job itself).
export type ValueLedgerEvent = {
  id: string;
  user_id: string;
  event_name: string;
  properties: Record<string, unknown>;
  source: string;
  idempotency_key: string;
  created_at: string;
};

export type ChurnRiskLevel = 'low' | 'medium' | 'high';

export type ValueLedgerRollup = {
  id: string;
  user_id: string;
  rollup_date: string;
  subscription_tier: string;
  pod_goal_hits_30d: number;
  pod_pace_delta_pct: number | null;
  alerts_fired_30d: number;
  alerts_acted_on_30d: number;
  alert_pnl_saved_30d: number | null;
  aria_recommendation_winrate_30d: number | null;
  aria_recommendation_count_30d: number;
  time_to_first_value_days: number | null;
  feature_adoption_rate: number;
  value_score: number;
  tier_price_normalized: number | null;
  value_to_price_ratio: number | null;
  churn_risk_score: number;
  churn_risk_level: ChurnRiskLevel;
  churn_risk_reasons: string[];
  upsell_candidate: boolean;
  managed_account_net_return_30d: number | null;
  fee_to_return_ratio_30d: number | null;
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
  // Connection Health & Data Freshness — set once when this alert has
  // been continuously suppressed (stale input) for 15+ minutes, so the
  // "alerts paused" notice fires once, not every evaluation cycle;
  // cleared on the next non-suppressed evaluation.
  stale_notification_sent_at: string | null;
  created_at: string;
};

export type AlertHistoryEntry = {
  id: string;
  alert_id: string;
  user_id: string;
  triggered_value: number;
  message: string;
  delivered_via: string[];
  // Connection Health & Data Freshness — true when this evaluation was
  // skipped because its input data was stale (connection health not
  // healthy/pending, or a position synced >5min ago); no email/in-app
  // delivery happens for a suppressed row.
  suppressed: boolean;
  suppressed_reason: string | null;
  created_at: string;
};

export type UsageEvent = {
  id: string;
  user_id: string;
  event_name: string;
  properties: Record<string, unknown>;
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
  // When this row first entered 'past_due' (set once per decline episode,
  // cleared to null on recovery to active/trialing). Grants a grace
  // period before access is revoked — see get-user-tier.ts.
  past_due_since: string | null;
  // The tier_contracts row active at signup or last renewal — stamped by
  // snapshotTierContractOnRenewal() (src/lib/tier-contracts/snapshot.ts),
  // never by a cancel/past_due webhook branch. Null for a row predating
  // 20260815000002_add_tier_contracts.sql or written before seed data
  // existed for its tier.
  tier_contract_id: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingWebhookEvent = {
  id: string;
  provider: 'stripe' | 'paystack' | 'flutterwave' | 'web3';
  event_id: string;
  event_type: string;
  // Non-sensitive metadata only — never the raw webhook payload. See
  // supabase/migrations/20260717000000_reconcile_subscriptions_for_billing.sql
  metadata: Record<string, unknown>;
  processed_at: string;
  // 'processing' -> 'completed' | 'failed'. A retry claim only skips
  // (true duplicate) on 'completed' — see
  // 20260724000002_fix_webhook_idempotency_on_partial_failure.sql.
  status: 'processing' | 'completed' | 'failed';
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

// ----------------------------------------------------------------------------
// VaultPoint Managed Accounts — custodial managed-trading product, a
// different regulatory category from Signal Mode / Managed Mode (which
// never take custody of anyone's money). See
// supabase/migrations/20260718000004_add_managed_accounts.sql.
// ----------------------------------------------------------------------------

// Placeholder tier set — the spec's own PRD Section 6 (Managed Tier
// definitions) was not available when this migration was written.
export type ManagedTier = 'bronze' | 'silver' | 'gold';
export type ManagedAccountStatus = 'pending_kyc' | 'pending_authorization' | 'pending_funding' | 'active' | 'closed';
export type KycStatus = 'pending' | 'verified' | 'rejected';
export type WithdrawalWindowCadence = 'monthly' | 'biweekly' | 'on_demand';
export type ManagedTradeSide = 'long' | 'short';
export type ProfitDistributionStatus = 'pending' | 'confirmed' | 'paid' | 'failed';
export type SignatureMethod = 'checkbox_and_typed_name';
export type ManagedAccountNotificationType =
  | 'onboarding_milestone'
  | 'distribution_requested'
  | 'distribution_paid'
  | 'withdrawal_window_open'
  | 'drawdown_warning';

export type DisclosureView = {
  id: string;
  user_id: string;
  document_version: string;
  viewed_at: string;
  scrolled_to_bottom_at: string | null;
  created_at: string;
};

export type ClientAuthorization = {
  id: string;
  user_id: string;
  document_version: string;
  document_url: string;
  typed_legal_name: string;
  signed_at: string;
  ip_address: string | null;
  signature_method: SignatureMethod;
  revoked_at: string | null;
  created_at: string;
};

export type ManagedAccount = {
  id: string;
  user_id: string;
  tier: ManagedTier;
  profit_split_pct: number;
  max_drawdown_pct: number;
  withdrawal_window_cadence: WithdrawalWindowCadence;
  next_withdrawal_window_date: string | null;
  client_authorization_id: string | null;
  kyc_status: KycStatus;
  kyc_verified_at: string | null;
  broker: 'bybit' | 'metatrader';
  // Same encrypted-at-rest pattern as broker_connections, deliberately
  // NOT stored in that table — see this migration's comment on why a
  // managed sub-account has a different trust model.
  encrypted_api_key: string | null;
  api_key_iv: string | null;
  encrypted_api_secret: string | null;
  api_secret_iv: string | null;
  mt_login: string | null;
  mt_server: string | null;
  mt_platform: MtPlatform | null;
  encrypted_mt_password: string | null;
  mt_password_iv: string | null;
  metaapi_account_id: string | null;
  metaapi_region: string | null;
  status: ManagedAccountStatus;
  starting_capital: number | null;
  current_balance: number | null;
  requires_disclosure_reconfirmation: boolean;
  // The active tier_name='managed' tier_contracts row, stamped once when
  // status transitions to 'active' in POST /api/managed-accounts/:id/fund
  // — NOT gated through subscriptions, since a Managed Account enrollment
  // is orthogonal to subscription_tier. See
  // 20260815000002_add_tier_contracts.sql.
  tier_contract_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ManagedTrade = {
  id: string;
  managed_account_id: string;
  symbol: string;
  side: ManagedTradeSide;
  size: number;
  entry_price: number;
  exit_price: number | null;
  realized_pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
};

export type ProfitDistribution = {
  id: string;
  managed_account_id: string;
  period_start: string;
  period_end: string;
  gross_pnl: number;
  client_share: number;
  vaultpoint_share: number;
  payout_method: string | null;
  status: ProfitDistributionStatus;
  statement_pdf_url: string | null;
  requested_at: string | null;
  confirmed_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export type ManagedAccountNotification = {
  id: string;
  user_id: string;
  managed_account_id: string;
  type: ManagedAccountNotificationType;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

export type JournalEntry = {
  id: string;
  user_id: string;
  note: string;
  created_at: string;
};

// Managed Trader Pathway — a third-party trader manages ANOTHER client's
// capital. Distinct from ManagedAccount above (VaultPoint itself manages
// a client's own money) — the two coexist deliberately, see
// 20260725000000_add_managed_trader_pathway.sql.
export type ManagedTraderStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export type ManagedTrader = {
  id: string;
  user_id: string;
  status: ManagedTraderStatus;
  trailing_90d_return: number | null;
  max_drawdown: number | null;
  academy_modules_confirmed: boolean;
  proposed_profit_split: number;
  approved_profit_split: number | null;
  max_clients: number | null;
  strategy_description: string | null;
  has_managed_funds_before: boolean | null;
  has_managed_funds_before_explanation: string | null;
  understands_trade_only_confirmed_at: string | null;
  agrees_to_audit_logging_confirmed_at: string | null;
  reviewer_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ManagedSubAccountStatus = 'active' | 'revoked' | 'closed';

export type ManagedSubAccount = {
  id: string;
  trader_id: string;
  client_user_id: string;
  broker_connection_id: string;
  status: ManagedSubAccountStatus;
  allocated_amount: number;
  profit_split_pct: number;
  platform_fee_pct: number;
  poa_signed_at: string | null;
  poa_document_url: string | null;
  poa_revoked_at: string | null;
  disclosure_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ManagedAccountSettlementPayoutStatus = 'pending' | 'paid' | 'failed';

export type ManagedAccountSettlement = {
  id: string;
  sub_account_id: string;
  period_start: string;
  period_end: string;
  realized_profit: number;
  trader_payout: number;
  platform_fee_amount: number;
  client_net: number;
  payout_status: ManagedAccountSettlementPayoutStatus;
  created_at: string;
};

export type ManagedAccountAuditEventType =
  | 'trade_executed'
  | 'poa_signed'
  | 'poa_revoked'
  | 'settlement_calculated'
  | 'payout_sent';

export type ManagedAccountAuditLogEntry = {
  id: string;
  sub_account_id: string;
  event_type: ManagedAccountAuditEventType;
  event_data: Record<string, unknown>;
  created_at: string;
};

// Managed Account Dispute & Escalation Policy.
// Matches supabase/migrations/20260816000000_add_dispute_escalation_policy.sql.
// DisputeTier (1-4, escalation level) is NOT the same vocabulary as
// ManagedAccount['tier'] ('bronze'/'silver'/'gold') — do not confuse the two.
export type DisputeTier = 1 | 2 | 3 | 4;
export type DisputeStatus = 'open' | 'resolved' | 'escalated' | 'closed';
export type DisputeCategory = 'fee' | 'performance' | 'recommendation' | 'other';

export type Dispute = {
  id: string;
  parent_dispute_id: string | null;
  user_id: string;
  managed_account_id: string | null;
  managed_sub_account_id: string | null;
  tier: DisputeTier;
  status: DisputeStatus;
  category: DisputeCategory;
  linked_event_ids: string[];
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_summary: string | null;
  resolution_amount_ngn: number | null;
  reviewer: string;
  escalated_from_tier: DisputeTier | null;
  escalation_reason: string | null;
  sla_alert_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DisputeSettings = {
  id: 1;
  tier2_support_owner_name: string | null;
  tier3_max_authorization_ngn: number | null;
  tier4_legal_contact: string | null;
  updated_at: string;
  updated_by: string | null;
};

// Automated Profit-Split Payout Calculation.
// Matches supabase/migrations/20260817000000_add_prop_payout_infrastructure.sql.
// payout_ledger/prop_firm_orders/managed_prop_accounts/audit_logs were the
// spec's own (fictional) names — this is the real table, built net-new.
export type SplitDirection = 'trader_first' | 'platform_first';

export type PropPayoutAgreement = {
  id: string;
  broker_connection_id: string;
  user_id: string;
  funding_partner: string;
  profit_split_pct: number;
  split_direction: SplitDirection;
  trader_payout_wallet_address: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type AccountBalanceSnapshot = {
  id: string;
  broker_connection_id: string;
  balance: number;
  synced_at: string;
};

export type WithdrawalEventConfidence = 'auto_detected' | 'requires_manual_confirmation';
export type WithdrawalEventStatus = 'pending' | 'confirmed' | 'rejected';

export type WithdrawalEvent = {
  id: string;
  broker_connection_id: string;
  user_id: string;
  detected_amount: number;
  balance_before: number;
  balance_after: number;
  detected_at: string;
  sync_source: string;
  confidence: WithdrawalEventConfidence;
  status: WithdrawalEventStatus;
  created_at: string;
};

export type PayoutCollectionMethod = 'crypto_two_step' | 'fiat_card_charge';
export type PayoutLedgerStatus = 'pending' | 'pending_trader_execution' | 'collected' | 'disputed' | 'failed';

export type PayoutLedgerEntry = {
  id: string;
  withdrawal_event_id: string;
  agreement_id: string;
  broker_connection_id: string;
  user_id: string;
  withdrawal_amount: number;
  trader_amount: number;
  vaultpoint_amount: number;
  funding_partner_amount: number;
  split_direction: SplitDirection;
  collection_method: PayoutCollectionMethod;
  status: PayoutLedgerStatus;
  trader_wallet_address: string | null;
  vaultpoint_wallet_address: string | null;
  trader_marked_executed_at: string | null;
  collected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PayoutCalculationAuditLogEntry = {
  id: string;
  withdrawal_event_id: string;
  payout_ledger_id: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  created_at: string;
};

export type PayoutSettings = {
  id: 1;
  vaultpoint_crypto_wallet_address: string | null;
  vaultpoint_crypto_network: string | null;
  updated_at: string;
  updated_by: string | null;
};

// Crypto Custody (Cobo) Integration.
// Matches supabase/migrations/20260818000001_add_crypto_custody_infrastructure.sql.
export type CustodyProviderName = 'cobo';
export type CustodyAccountStatus = 'active' | 'frozen' | 'closed';

export type CustodyAccount = {
  id: string;
  user_id: string;
  provider: CustodyProviderName;
  provider_wallet_id: string | null;
  deposit_address: string | null;
  chain: string;
  status: CustodyAccountStatus;
  created_at: string;
  updated_at: string;
};

export type CustodyAsset = 'USDT' | 'USDC';
export type CustodyTransactionDirection = 'deposit' | 'withdrawal';
export type CustodyTransactionStatus = 'pending' | 'pending_review' | 'confirmed' | 'failed';

export type CustodyTransaction = {
  id: string;
  custody_account_id: string;
  direction: CustodyTransactionDirection;
  amount: number;
  asset: CustodyAsset;
  provider_tx_id: string | null;
  status: CustodyTransactionStatus;
  confirmed_at: string | null;
  ledger_entry_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CustodySettings = {
  id: 1;
  withdrawal_review_hold_threshold_usd: number | null;
  updated_at: string;
  updated_by: string | null;
};

// Step-Up Auth, Ticket 1 — registered push-notification device tokens.
export type DevicePlatform = 'ios' | 'android';

export type UserDevice = {
  id: string;
  user_id: string;
  platform: DevicePlatform;
  encrypted_device_token: string;
  device_token_iv: string;
  device_token_hash: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

// Step-Up Auth, Ticket 2 — approval state machine + its audit trail.
export type StepUpStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type StepUpMethod = 'push' | 'totp' | 'telegram';

export type StepUpApproval = {
  id: string;
  user_id: string;
  action_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  methods: StepUpMethod[];
  status: StepUpStatus;
  method: StepUpMethod | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
};

export type StepUpAuditLogEntry = {
  id: string;
  approval_id: string;
  user_id: string;
  action_type: string;
  resource_id: string | null;
  status: StepUpStatus;
  method: StepUpMethod | null;
  created_at: string;
};

// Step-Up Auth, Ticket 6 — recognized browser fingerprints for the web
// login flow's new-device alert.
export type LoginDeviceFingerprint = {
  id: string;
  user_id: string;
  fingerprint_hash: string;
  user_agent: string | null;
  first_seen_ip: string | null;
  created_at: string;
  last_seen_at: string;
};

// Step-Up Auth, Ticket 3 — TOTP enrollment.
export type TotpEnrollmentStatus = 'pending' | 'active';

export type TotpEnrollment = {
  id: string;
  user_id: string;
  encrypted_secret: string;
  secret_iv: string;
  status: TotpEnrollmentStatus;
  last_consumed_counter: number | null;
  created_at: string;
  activated_at: string | null;
};

// Step-Up Auth, Ticket 4 — Telegram account linking.
export type TelegramLinkCode = {
  id: string;
  user_id: string;
  code: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export type TelegramLink = {
  id: string;
  user_id: string;
  chat_id: string;
  linked_at: string;
};

export type KycVendor = 'verifyme' | 'onfido';
export type KycVerificationState =
  | 'not_started'
  | 'pending'
  | 'processing'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'error';

export type KycVerification = {
  id: string;
  user_id: string;
  // Exactly one of these two is non-null — see
  // kyc_verifications_exactly_one_subject
  // (20260726000000_extend_managed_trader_application.sql).
  managed_account_id: string | null;
  managed_trader_id: string | null;
  vendor: KycVendor;
  state: KycVerificationState;
  vendor_ref: string | null;
  // Normalized {checks_passed, reasons[]} only — see the migration's
  // comment on why raw vendor payloads/documents never land here.
  result_summary: Record<string, unknown> | null;
  failure_reason: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type KycWebhookEvent = {
  id: string;
  vendor: KycVendor;
  event_id: string;
  event_type: string;
  status: 'processing' | 'completed' | 'failed';
  normalized_payload: Record<string, unknown> | null;
  received_at: string;
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

// Aria Pantheon — written only by the Python worker modules
// (services/broker-sync/app/pantheon/*.py, service-role) and updated
// only by src/lib/aria/findings.ts's status-transition helpers (also
// service-role — no client insert/update policy exists on this table).
// See supabase/migrations/20260813000000_add_aria_findings.sql.
export type AriaFinding = {
  id: string;
  user_id: string;
  source_agent: AriaFindingSourceAgent;
  finding_type: AriaFindingType;
  severity: AriaFindingSeverity;
  raw_data: Record<string, unknown>;
  dedup_key: string;
  status: AriaFindingStatus;
  created_at: string;
  acknowledged_at: string | null;
  delivered_at: string | null;
};

// Tier Contract — What Each Tier Promises. Matches
// supabase/migrations/20260815000002_add_tier_contracts.sql exactly.
// Written only via create_tier_contract_version() — no direct TS
// insert/update path, ever (see that migration's comment on why an active
// row is never updated in place).
export type TierContract = {
  id: string;
  tier_name: TierName;
  version: number;
  effective_date: string;
  price_ngn: number | null;
  price_usd: number | null;
  status: TierContractStatus;
  created_by: string | null;
  change_reason: string | null;
  // Null = not yet reviewed by Legal/Compliance. Only meaningfully gates
  // tier_name='managed' in v1 — see the migration's header comment.
  compliance_signoff_at: string | null;
  created_at: string;
};

export type TierCommitment = {
  id: string;
  tier_contract_id: string;
  commitment_key: string;
  commitment_description: string;
  commitment_type: CommitmentType;
  measurable: boolean;
  // Free text, NOT FK-validated — no Value Ledger metric registry exists
  // anywhere in this codebase yet. See the migration's header comment.
  metric_key: string | null;
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

// Aria Context Builder — the exact sanitized payload buildAriaContext()
// sent to the model, once per fresh (non-cached) build. See
// src/lib/aria/context.ts. payload is the AriaContext shape
// (src/lib/aria/types.ts) as plain JSON, not re-typed here — this is an
// audit/reproducibility record, not something the app reads back and
// deserializes into a live AriaContext.
export type AriaContextSnapshot = {
  id: string;
  user_id: string;
  version: string;
  payload: Record<string, unknown>;
  generated_at: string;
  expires_at: string;
  created_at: string;
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
          | 'source'
          | 'account_type'
          | 'health'
          | 'last_success_at'
          | 'last_attempt_at'
          | 'consecutive_failures'
          | 'last_error_code'
          | 'next_attempt_at'
          | 'closed_at'
          | 'closed_reason'
          | 'notified_health_state'
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
          // Partner Offers v1 — defaults to 'manual'/'live' at the DB level;
          // only POST /api/brokers's Hantec-connect path ever sets these.
          source?: 'manual' | 'partner_hantec';
          account_type?: 'live' | 'simulated';
          // Connection Health & Data Freshness — all DB-defaulted; a
          // brand new connection starts 'pending' with next_attempt_at=now().
          health?: HealthState;
          last_success_at?: string | null;
          last_attempt_at?: string | null;
          consecutive_failures?: number;
          last_error_code?: string | null;
          next_attempt_at?: string;
          closed_at?: string | null;
          closed_reason?: ClosedReason | null;
          notified_health_state?: HealthState | null;
        };
        Update: Partial<Omit<BrokerConnection, 'id' | 'user_id'>>;
        Relationships: [];
      };
      partner_offers: {
        Row: PartnerOffer;
        // Founder manages rows via the Table Editor / a future admin
        // tool, not through this client — same treatment as academy_videos.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      partner_referrals: {
        Row: PartnerReferral;
        Insert: Omit<PartnerReferral, 'id' | 'clicked_at' | 'returned_at' | 'connected_at' | 'broker_connection_id' | 'nudges_sent' | 'status'> & {
          status?: 'clicked';
        };
        Update: Partial<Omit<PartnerReferral, 'id' | 'user_id' | 'offer_id' | 'state_token'>>;
        Relationships: [];
      };
      positions: {
        Row: Position;
        Insert: Omit<
          Position,
          'id' | 'synced_at' | 'currency' | 'reality' | 'asset_class' | 'argus_last_severity' | 'plutus_last_severity'
        > & {
          currency?: string;
          // reality is trigger-derived server-side — never actually set by
          // any insert, TS or Python; optional here purely so the type
          // doesn't demand a value no caller should ever provide.
          reality?: Reality;
          asset_class?: ValuationAssetClass;
          // DB-defaulted to 'none' — only services/broker-sync/app/
          // pantheon/argus.py|plutus.py ever set these, via Update, not Insert.
          argus_last_severity?: PantheonSeverityBucket;
          plutus_last_severity?: PantheonSeverityBucket;
        };
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
        Insert: Omit<
          PortfolioSnapshot,
          'id' | 'created_at' | 'currency' | 'fx_rates' | 'rates_stale' | 'degraded' | 'degraded_sources'
        > & {
          currency?: string;
          fx_rates?: Record<string, string>;
          rates_stale?: boolean;
          degraded?: boolean;
          degraded_sources?: Array<{ broker: BrokerType; label: string }>;
        };
        Update: never; // append-only
        Relationships: [];
      };
      connection_health_events: {
        Row: ConnectionHealthEvent;
        Insert: Omit<ConnectionHealthEvent, 'id' | 'created_at' | 'from_health' | 'error_code'> & {
          from_health?: HealthState | null;
          error_code?: string | null;
        };
        Update: never; // append-only
        Relationships: [
          {
            foreignKeyName: 'connection_health_events_connection_id_fkey';
            columns: ['connection_id'];
            isOneToOne: false;
            referencedRelation: 'broker_connections';
            referencedColumns: ['id'];
          },
        ];
      };
      aria_context_snapshots: {
        Row: AriaContextSnapshot;
        Insert: Omit<AriaContextSnapshot, 'id' | 'created_at' | 'version' | 'expires_at'> & {
          version?: string;
          expires_at?: string;
        };
        Update: never; // append-only
        Relationships: [];
      };
      fx_rates: {
        Row: FxRate;
        Insert: Omit<FxRate, 'id' | 'fetched_at'> & { fetched_at?: string };
        Update: never; // audit history — every fetch is a new row, never updated
        Relationships: [];
      };
      manual_assets: {
        Row: ManualAsset;
        Insert: Omit<ManualAsset, 'id' | 'created_at' | 'updated_at' | 'reality' | 'liquidity' | 'asset_class'> & {
          reality?: Reality;
          liquidity?: Liquidity;
          asset_class?: ValuationAssetClass;
        };
        Update: Partial<Omit<ManualAsset, 'id' | 'user_id'>>;
        Relationships: [];
      };
      savings_pods: {
        Row: SavingsPod;
        Insert: Omit<SavingsPod, 'id' | 'created_at' | 'updated_at' | 'current_amount' | 'liquidity'> & {
          current_amount?: number;
          liquidity?: Liquidity;
        };
        Update: Partial<Omit<SavingsPod, 'id' | 'user_id'>>;
        Relationships: [];
      };
      pod_contributions: {
        Row: PodContribution;
        Insert: Omit<PodContribution, 'id' | 'created_at' | 'currency'> & { currency?: string };
        Update: never; // append-only
        Relationships: [];
      };
      wallets: {
        Row: Wallet;
        // No direct insert — only ever created inside wallet_apply_transaction().
        Insert: never;
        Update: never;
        Relationships: [];
      };
      wallet_transactions: {
        Row: WalletTransaction;
        // Only ever written inside wallet_apply_transaction() — no direct insert policy.
        Insert: never;
        Update: never; // append-only
        Relationships: [];
      };
      withdrawal_requests: {
        Row: WithdrawalRequest;
        Insert: Omit<WithdrawalRequest, 'id' | 'wallet_transaction_id' | 'step_up_verified_at' | 'requested_at' | 'processed_at' | 'status'> & {
          status?: 'requested';
        };
        Update: Partial<Omit<WithdrawalRequest, 'id' | 'user_id'>>;
        Relationships: [];
      };
      wallet_web3_deposit_addresses: {
        Row: WalletWeb3DepositAddress;
        Insert: Omit<WalletWeb3DepositAddress, 'id' | 'created_at'>;
        Update: never;
        Relationships: [];
      };
      kyc_tier_limits: {
        Row: KycTierLimits;
        // Reference table — only ever populated by the migration's own seed
        // data, never written by application code.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      wallet_kyc_tier_verifications: {
        Row: WalletKycTierVerification;
        // Only ever written via a service-role client, from
        // src/lib/kyc/tier-state.ts — no client insert/update policy.
        Insert: Omit<WalletKycTierVerification, 'id' | 'submitted_at' | 'decided_at' | 'created_at' | 'updated_at' | 'status'> & {
          status?: WalletKycTierVerificationStatus;
        };
        Update: Partial<Omit<WalletKycTierVerification, 'id' | 'user_id' | 'created_at'>>;
        Relationships: [];
      };
      alerts: {
        Row: Alert;
        // last_triggered_at is set only by the Python Alert Engine's own
        // update after firing — never by the Next.js create/edit routes.
        // stale_notification_sent_at is likewise Python-only.
        Insert: Omit<Alert, 'id' | 'created_at' | 'last_triggered_at' | 'stale_notification_sent_at'> & {
          stale_notification_sent_at?: string | null;
        };
        Update: Partial<Omit<Alert, 'id' | 'user_id'>>;
        Relationships: [];
      };
      alert_history: {
        Row: AlertHistoryEntry;
        Insert: Omit<AlertHistoryEntry, 'id' | 'created_at' | 'suppressed' | 'suppressed_reason'> & {
          suppressed?: boolean;
          suppressed_reason?: string | null;
        };
        Update: never; // append-only
        Relationships: [];
      };
      usage_events: {
        Row: UsageEvent;
        Insert: Omit<UsageEvent, 'id' | 'created_at' | 'properties'> & { properties?: Record<string, unknown> };
        Update: never; // append-only
        Relationships: [];
      };
      value_ledger_events: {
        Row: ValueLedgerEvent;
        // Only ever written via value_ledger_apply_event() — no direct
        // insert policy for any role, matching kyc_webhook_events' posture.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      value_ledger_rollups: {
        Row: ValueLedgerRollup;
        // Only ever written by the nightly rollup job's service-role
        // client — no client insert/update policy.
        Insert: Omit<ValueLedgerRollup, 'id' | 'created_at'>;
        Update: Partial<Omit<ValueLedgerRollup, 'id' | 'user_id' | 'rollup_date' | 'created_at'>>;
        Relationships: [];
      };
      subscriptions: {
        Row: Subscription;
        // paystack_authorization_code starts null on every insert (the
        // checkout-initiation routes never have it yet) — only the
        // Paystack webhook's later UPDATE ever sets it, on charge.success.
        // tier_contract_id is the same shape: no insert call site ever
        // passes it (it's stamped by a later UPDATE via
        // snapshotTierContractOnRenewal, after the row already exists).
        Insert: Omit<
          Subscription,
          'id' | 'created_at' | 'updated_at' | 'paystack_authorization_code' | 'tier_contract_id'
        > & {
          paystack_authorization_code?: string | null;
          tier_contract_id?: string | null;
        };
        Update: Partial<Omit<Subscription, 'id' | 'user_id'>>;
        Relationships: [];
      };
      billing_webhook_events: {
        Row: BillingWebhookEvent;
        Insert: Omit<BillingWebhookEvent, 'id' | 'processed_at' | 'status'> & { status?: BillingWebhookEvent['status'] };
        Update: Pick<BillingWebhookEvent, 'status'>;
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
      // No delete policy for any role. One legitimate update exists —
      // PATCH /api/managed-accounts/disclosure-view/:id sets
      // scrolled_to_bottom_at once the client finishes reading; nothing
      // else about a disclosure view row is ever revised after insert.
      disclosure_views: {
        Row: DisclosureView;
        Insert: Omit<DisclosureView, 'id' | 'created_at' | 'viewed_at'> & { viewed_at?: string };
        Update: Pick<DisclosureView, 'scrolled_to_bottom_at'>;
        Relationships: [];
      };
      client_authorizations: {
        Row: ClientAuthorization;
        Insert: Omit<ClientAuthorization, 'id' | 'created_at'>;
        Update: never; // a signed authorization is immutable — revoke via revoked_at through a dedicated flow, not a raw update
        Relationships: [];
      };
      managed_accounts: {
        Row: ManagedAccount;
        // tier_contract_id starts null on every insert — the enrollment
        // creation route never has it yet, only POST
        // .../:id/fund's later UPDATE (when status -> 'active') sets it.
        Insert: Omit<ManagedAccount, 'id' | 'created_at' | 'updated_at' | 'tier_contract_id'> & {
          tier_contract_id?: string | null;
        };
        Update: Partial<Omit<ManagedAccount, 'id' | 'user_id'>>;
        Relationships: [];
      };
      managed_trades: {
        Row: ManagedTrade;
        Insert: Omit<ManagedTrade, 'id' | 'created_at'>;
        Update: never; // a closed trade's record is final
        Relationships: [];
      };
      profit_distributions: {
        Row: ProfitDistribution;
        Insert: Omit<ProfitDistribution, 'id' | 'created_at'>;
        Update: Partial<Omit<ProfitDistribution, 'id' | 'managed_account_id' | 'period_start' | 'period_end'>>;
        Relationships: [];
      };
      managed_account_notifications: {
        Row: ManagedAccountNotification;
        Insert: Omit<ManagedAccountNotification, 'id' | 'created_at'>;
        Update: Pick<ManagedAccountNotification, 'read_at'>;
        Relationships: [];
      };
      journal_entries: {
        Row: JournalEntry;
        Insert: Omit<JournalEntry, 'id' | 'created_at'>;
        Update: never; // append-only, same as the Telegram bot's journal.log
        Relationships: [];
      };
      managed_traders: {
        Row: ManagedTrader;
        // Client writes go through service-role only (see the migration's
        // RLS comment) — the /apply route inserts via createServiceClient
        // after validating the session, never a raw client insert.
        Insert: Omit<ManagedTrader, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<ManagedTrader, 'id' | 'user_id' | 'created_at'>>;
        Relationships: [];
      };
      managed_sub_accounts: {
        Row: ManagedSubAccount;
        Insert: Omit<ManagedSubAccount, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<ManagedSubAccount, 'id' | 'trader_id' | 'client_user_id' | 'created_at'>>;
        Relationships: [];
      };
      managed_account_settlements: {
        Row: ManagedAccountSettlement;
        Insert: Omit<ManagedAccountSettlement, 'id' | 'created_at'>;
        Update: Pick<ManagedAccountSettlement, 'payout_status'>;
        Relationships: [];
      };
      managed_account_audit_log: {
        Row: ManagedAccountAuditLogEntry;
        Insert: Omit<ManagedAccountAuditLogEntry, 'id' | 'created_at'>;
        Update: never; // append-only
        Relationships: [];
      };
      // Written only via each dispute route's own service-role client
      // after its own auth check — no client insert/update policy exists
      // (see the migration's RLS comment).
      disputes: {
        Row: Dispute;
        Insert: Omit<Dispute, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<Dispute, 'id' | 'user_id' | 'created_at'>>;
        Relationships: [];
      };
      dispute_settings: {
        Row: DisputeSettings;
        Insert: never; // singleton row, seeded by the migration itself
        Update: Partial<Omit<DisputeSettings, 'id' | 'updated_at'>>;
        Relationships: [];
      };
      // Written only via each route's own service-role client after its
      // own auth check — no client insert/update policy exists (see the
      // migration's RLS comment). trader_payout_wallet_address is the one
      // field the TRADER sets themselves, still routed through
      // PUT /api/prop-payout-agreements/:id/wallet's own ownership check,
      // never a raw client update.
      prop_payout_agreements: {
        Row: PropPayoutAgreement;
        Insert: Omit<PropPayoutAgreement, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<PropPayoutAgreement, 'id' | 'broker_connection_id' | 'user_id' | 'created_at'>>;
        Relationships: [];
      };
      account_balance_snapshots: {
        Row: AccountBalanceSnapshot;
        Insert: Omit<AccountBalanceSnapshot, 'id'>;
        Update: never; // append-only time series
        Relationships: [];
      };
      withdrawal_events: {
        Row: WithdrawalEvent;
        Insert: Omit<WithdrawalEvent, 'id' | 'created_at'>;
        Update: Pick<WithdrawalEvent, 'status'>;
        Relationships: [];
      };
      // Written only by calculate_payout_split() (insert) and each
      // collection-step route's service-role client (status transitions)
      // — never a raw client write. prevent_collected_payout_ledger_edit()
      // additionally blocks any UPDATE once status='collected' at the DB
      // layer, so this Update type is a ceiling, not the only guard.
      payout_ledger: {
        Row: PayoutLedgerEntry;
        Insert: never; // only ever written by calculate_payout_split()
        Update: Partial<Pick<PayoutLedgerEntry, 'status' | 'collected_at' | 'trader_marked_executed_at'>>;
        Relationships: [];
      };
      payout_calculation_audit_log: {
        Row: PayoutCalculationAuditLogEntry;
        Insert: never; // only ever written by calculate_payout_split()
        Update: never; // append-only
        Relationships: [];
      };
      payout_settings: {
        Row: PayoutSettings;
        Insert: never; // singleton row, seeded by the migration itself
        Update: Partial<Omit<PayoutSettings, 'id' | 'updated_at'>>;
        Relationships: [];
      };
      // Written only via src/lib/wallet/web3-adapter.ts (delegating to
      // src/lib/custody/cobo-adapter.ts when COBO_INTEGRATION_ENABLED) and
      // the admin custody-transactions review routes — no client
      // insert/update policy exists.
      custody_accounts: {
        Row: CustodyAccount;
        Insert: Omit<CustodyAccount, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Pick<CustodyAccount, 'provider_wallet_id' | 'deposit_address' | 'status'>>;
        Relationships: [];
      };
      custody_transactions: {
        Row: CustodyTransaction;
        Insert: Omit<CustodyTransaction, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Pick<CustodyTransaction, 'status' | 'provider_tx_id' | 'confirmed_at' | 'ledger_entry_id'>>;
        Relationships: [];
      };
      custody_settings: {
        Row: CustodySettings;
        Insert: never; // singleton row, seeded by the migration itself
        Update: Partial<Omit<CustodySettings, 'id' | 'updated_at'>>;
        Relationships: [];
      };
      user_devices: {
        Row: UserDevice;
        // Written only via src/lib/auth/devices.ts's service-role
        // registerDevice() — RLS refuses client writes outright (see the
        // migration's RLS comment).
        Insert: Omit<UserDevice, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<UserDevice, 'id' | 'created_at'>>;
        Relationships: [];
      };
      // Written only via src/lib/auth/step-up.ts's service-role client —
      // RLS refuses client writes outright (see the migration's RLS
      // comment). methods is decided once at insert and never revised.
      step_up_approvals: {
        Row: StepUpApproval;
        Insert: Omit<StepUpApproval, 'id' | 'created_at' | 'status' | 'method' | 'resolved_at'> & {
          status?: StepUpStatus;
          method?: StepUpMethod | null;
          resolved_at?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      step_up_audit_log: {
        Row: StepUpAuditLogEntry;
        Insert: Omit<StepUpAuditLogEntry, 'id' | 'created_at'>;
        Update: never; // append-only
        Relationships: [];
      };
      // Written only via src/lib/auth/login-alerts.ts's service-role
      // client — RLS refuses client writes outright (see the migration's
      // RLS comment).
      login_device_fingerprints: {
        Row: LoginDeviceFingerprint;
        Insert: Omit<LoginDeviceFingerprint, 'id' | 'created_at' | 'last_seen_at'> & {
          last_seen_at?: string;
        };
        Update: Pick<LoginDeviceFingerprint, 'last_seen_at'>;
        Relationships: [];
      };
      // Written only via src/lib/auth/totp-enrollment.ts's service-role
      // client — RLS refuses client writes outright.
      totp_enrollments: {
        Row: TotpEnrollment;
        Insert: Omit<TotpEnrollment, 'id' | 'created_at' | 'status' | 'last_consumed_counter' | 'activated_at'> & {
          status?: TotpEnrollmentStatus;
          last_consumed_counter?: number | null;
          activated_at?: string | null;
        };
        Update: Partial<Pick<TotpEnrollment, 'encrypted_secret' | 'secret_iv' | 'status' | 'last_consumed_counter' | 'activated_at'>>;
        Relationships: [];
      };
      // Written only via src/lib/auth/telegram-link.ts's service-role
      // client — RLS refuses client writes outright.
      telegram_link_codes: {
        Row: TelegramLinkCode;
        Insert: Omit<TelegramLinkCode, 'id' | 'created_at' | 'consumed_at'> & { consumed_at?: string | null };
        Update: Pick<TelegramLinkCode, 'consumed_at'>;
        Relationships: [];
      };
      telegram_links: {
        Row: TelegramLink;
        Insert: Omit<TelegramLink, 'id' | 'linked_at'> & { linked_at?: string };
        Update: never;
        Relationships: [];
      };
      kyc_verifications: {
        Row: KycVerification;
        // Only ever written via a service-role client (RLS refuses
        // client writes outright — verified in
        // scripts/verify-kyc-rls-tmp.mjs during this migration's shadow
        // rehearsal). Typed with normal Insert/Update, same as
        // billing_webhook_events, since the enforcement point is RLS,
        // not the TS type.
        Insert: Omit<KycVerification, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<KycVerification, 'id' | 'user_id' | 'created_at'>>;
        Relationships: [];
      };
      kyc_webhook_events: {
        Row: KycWebhookEvent;
        Insert: Omit<KycWebhookEvent, 'id' | 'received_at' | 'status'> & { status?: KycWebhookEvent['status'] };
        Update: Pick<KycWebhookEvent, 'status'>;
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
      // Insert is real (not never) as of Aria Pantheon: the proactive
      // delivery route (src/app/api/aria/pantheon/proactive-check/route.ts,
      // service-role) is now a second legitimate writer alongside the
      // Python worker modules' in-app delivery helpers — there's no Python
      // process a Vercel cron route can hand this off to. Still no
      // client-facing RLS insert policy; both writers use the service role.
      aria_conversations: {
        Row: AriaConversation;
        Insert: Omit<AriaConversation, 'id' | 'created_at'>;
        Update: never;
        Relationships: [];
      };
      // Written only by the Python worker modules (service-role) — no
      // Next.js insert path. Update is real (not never): src/lib/aria/
      // findings.ts's status-transition helpers are the one TS-side write
      // path, service-role, since aria_findings has no client update policy.
      aria_findings: {
        Row: AriaFinding;
        Insert: never;
        Update: Partial<Pick<AriaFinding, 'status' | 'acknowledged_at' | 'delivered_at'>>;
        Relationships: [];
      };
      // Written only via create_tier_contract_version() (Postgres
      // function) — never a direct TS insert/update. An active row is
      // never updated in place; a new version is always a new row. See
      // 20260815000002_add_tier_contracts.sql.
      tier_contracts: {
        Row: TierContract;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      tier_commitments: {
        Row: TierCommitment;
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'tier_commitments_tier_contract_id_fkey';
            columns: ['tier_contract_id'];
            isOneToOne: false;
            referencedRelation: 'tier_contracts';
            referencedColumns: ['id'];
          },
        ];
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
      // Args grew a p_currency param in 20260804000000_add_money_currency_layer.sql
      // (currency-safety check, no conversion) — signature was dropped and
      // recreated, not overloaded.
      // Return shape grew goal_just_hit/target_amount/pod_deadline/
      // pod_created_at in 20260815000001_instrument_pod_goal_hit.sql —
      // lets the calling route emit a value_ledger_events pod_goal_hit row.
      contribute_to_pod: {
        Args: {
          p_pod_id: string;
          p_user_id: string;
          p_amount: number;
          p_note?: string | null;
          p_currency?: string | null;
        };
        Returns: {
          contribution_id: string;
          new_current_amount: number;
          goal_just_hit: boolean;
          target_amount: number;
          pod_deadline: string | null;
          pod_created_at: string;
        }[];
      };
      // supabase/migrations/20260815000002_add_tier_contracts.sql — the
      // only sanctioned write path for a new tier_contract version.
      create_tier_contract_version: {
        Args: {
          p_tier_name: string;
          p_price_ngn: number | null;
          p_price_usd: number | null;
          p_effective_date: string;
          p_created_by: string | null;
          p_change_reason: string;
          p_commitments: {
            commitment_key: string;
            commitment_description: string;
            commitment_type: CommitmentType;
            measurable: boolean;
            metric_key: string | null;
          }[];
        };
        Returns: {
          tier_contract_id: string;
          version: number;
        }[];
      };
      // supabase/migrations/20260802000000_add_wallet.sql
      wallet_apply_transaction: {
        Args: {
          p_user_id: string;
          p_type: WalletTxnType;
          p_amount: number;
          p_currency: string;
          p_provider: WalletProviderEnum;
          p_provider_reference: string;
          p_idempotency_key: string;
          p_metadata?: Record<string, unknown>;
        };
        Returns: {
          transaction_id: string;
          new_balance: number;
        }[];
      };
      // supabase/migrations/20260814000000_add_wallet_kyc_tiering.sql
      wallet_check_kyc_limit: {
        Args: {
          p_user_id: string;
          p_type: string;
          p_amount: number;
          p_currency?: string;
        };
        Returns: {
          allowed: boolean;
          reason_code: string | null;
          message: string | null;
        }[];
      };
      // supabase/migrations/20260815000000_add_value_ledger.sql
      value_ledger_apply_event: {
        Args: {
          p_user_id: string;
          p_event_name: string;
          p_idempotency_key: string;
          p_properties?: Record<string, unknown>;
          p_source?: string;
        };
        Returns: {
          event_id: string;
          inserted: boolean;
        }[];
      };
      // supabase/migrations/20260726000002_add_step_up_approvals.sql
      confirm_step_up_approval: {
        Args: {
          p_approval_id: string;
          p_user_id: string;
          p_decision: StepUpStatus;
          p_method: StepUpMethod;
        };
        Returns: {
          out_status: StepUpStatus;
          out_resolved_at: string;
          already_resolved: boolean;
        }[];
      };
      // supabase/migrations/20260817000000_add_prop_payout_infrastructure.sql
      // Returns a single payout_ledger row (RETURNS public.payout_ledger,
      // not SETOF) — PostgREST returns a single object for this, not an
      // array, unlike every other Functions entry above.
      calculate_payout_split: {
        Args: {
          p_withdrawal_event_id: string;
        };
        Returns: PayoutLedgerEntry;
      };
    };
  };
}
