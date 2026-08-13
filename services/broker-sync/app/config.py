
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


settings = Settings()
