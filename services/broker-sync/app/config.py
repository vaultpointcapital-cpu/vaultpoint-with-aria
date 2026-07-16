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

    poll_interval_seconds: int = 60
    cache_ttl_seconds: int = 55
    sync_rate_limit_seconds: int = 60


settings = Settings()
