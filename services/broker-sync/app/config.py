
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_service_role_key: str

    # Must match the Next.js app's ENCRYPTION_KEY exactly — this service
    # only ever decrypts what that app encrypted.
    encryption_key: str

    upstash_redis_rest_url: str
    upstash_redis_rest_token: str

    # Must match the Next.js app's PYTHON_SERVICE_API_KEY — the only
    # accepted caller of POST /sync/{user_id}.
    python_service_api_key: str

    # Service-level MetaApi account token — authenticates VaultPoint's own
    # MetaApi account, not any individual user. Only needed once a
    # metatrader broker_connections row exists; optional so the service
    # still starts cleanly for deployments that haven't enabled
    # MetaTrader support yet.
    metaapi_token: str | None = None

    # Optional — error reporting is disabled entirely (not degraded) when
    # unset, so local dev and any deployment that hasn't set up Sentry
    # yet doesn't need a dummy value.
    sentry_dsn: str | None = None

    poll_interval_seconds: int = 60
    cache_ttl_seconds: int = 55
    sync_rate_limit_seconds: int = 60

    # Alert Engine (Sprint 7-8). Optional so the service still starts
    # cleanly without email delivery configured — an unset key means
    # alerts still evaluate and fire (in-app + logged), just without the
    # email leg.
    resend_api_key: str | None = None
    # Sender must be on a domain verified in Resend — see the deployment
    # workstream's DNS records. No default: an alert email from an
    # unverified/placeholder address would just bounce or land in spam.
    alert_email_from: str | None = None
    # Absolute base URL used to build the "view in app" link in alert
    # emails — same app, no separate env var already covers this on the
    # Python side.
    app_base_url: str = "http://localhost:3000"

    # How long after firing before the same alert can fire again, even if
    # its condition is still true — prevents spamming on a value
    # hovering near the threshold. Per spec: 4 hours.
    alert_cooldown_hours: float = 4
    alert_evaluation_interval_seconds: int = 60

    # Managed Mode (Signal Mode Part 2 — autonomous execution). Same
    # cadence as the other two jobs by default; kept as its own setting
    # since this is the highest-stakes cycle in the service and may need
    # independent tuning without touching poll/alert timing.
    managed_mode_evaluation_interval_seconds: int = 60

    # Wallet reconciliation (supabase/migrations/20260802000000_add_wallet.sql).
    # Must match the Next.js app's PAYSTACK_SECRET_KEY/STRIPE_SECRET_KEY
    # exactly — same "read-only mirror of the Next.js app's own credentials"
    # pattern as encryption_key above. Optional so the service still starts
    # cleanly in a deployment that hasn't enabled the wallet feature yet;
    # the job itself skips its cycle (logged, not a crash) if either is unset.
    paystack_secret_key: str | None = None
    stripe_secret_key: str | None = None
    # Once daily by default — a nightly diff, not a live reconciliation.
    wallet_reconciliation_interval_seconds: int = 86400

    # Money & Currency Layer (supabase/migrations/20260804000000_add_money_currency_layer.sql).
    # Fiat rates (NGN, GHS, KES, GBP, EUR) come from Open Exchange Rates,
    # gated on this key — unset means that leg logs and skips (no vendor
    # account exists in this environment yet), same placeholder treatment
    # as Paystack Transfers/Stripe Connect in the wallet build. Crypto/
    # stablecoin rates need no key — Binance's public ticker endpoint.
    open_exchange_rates_app_id: str | None = None
    # Half the Redis TTL (3600s) below, so a single failed run never
    # causes a cache miss — same reasoning as every other job's interval.
    fx_refresh_interval_seconds: int = 1800

    # Aria Pantheon — Hermes opportunity scan (services/broker-sync/app/
    # pantheon/hermes.py). 20 min is a round middle value within the
    # spec's 15-30 min band. Move/volume thresholds and the finding TTL
    # are both tunable without a code change.
    hermes_scan_interval_seconds: int = 1200
    hermes_move_threshold_pct: float = 10.0
    hermes_min_volume_usd: float = 50_000_000.0
    hermes_finding_ttl_hours: float = 4.0

    # Aria Autonomous Trading Agent — Scanner Service (app/scanner/).
    # PRD default is "1-5 min, configurable per symbol/strategy"; 120s is
    # the round middle of that band. Per-symbol overrides live on
    # watchlist_symbols.scan_interval_seconds itself (read, not yet acted
    # on independently — the scheduler still runs one shared cycle at this
    # interval; true per-symbol cadence is a later refinement once more
    # than a handful of symbols are configured).
    scanner_interval_seconds: int = 120

    # Signal Engine (app/signal_engine/) — scores newly-produced
    # candidate_setups via Claude, once per candidate. Optional and
    # skip-when-unset like every other vendor key in this file: no key
    # means score_pending_candidates() logs and skips its cycle rather
    # than crashing, so a deployment that hasn't enabled Aria scoring yet
    # still starts cleanly. Reuses the same env var name
    # (ANTHROPIC_API_KEY) the Next.js app's src/app/api/aria/chat/route.ts
    # already reads, since both are the same Anthropic account.
    anthropic_api_key: str | None = None
    signal_engine_model: str = "claude-sonnet-5"
    signal_engine_max_tokens: int = 2048
    signal_engine_interval_seconds: int = 300

    # Decision Gate (app/decision_gate/) — routes each signal_scores row
    # to manual (step-up alert) or auto (execution) handling per account.
    # confidence_threshold is 0-100, matching signal_scores.confidence_score's
    # own scale. cooldown/daily-loss values are the PRD's own fixed numbers
    # ("-10% daily loss -> 24h pause"), deliberately not reusing
    # managed_mode_daily_loss_limit_pct's DB-configurable 5-20% range — a
    # different product with a different, fixed rule.
    decision_gate_interval_seconds: int = 60
    decision_gate_confidence_threshold: float = 75.0
    decision_gate_daily_loss_limit_pct: float = 10.0
    decision_gate_cooldown_hours: float = 24.0


settings = Settings()
