
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


settings = Settings()
