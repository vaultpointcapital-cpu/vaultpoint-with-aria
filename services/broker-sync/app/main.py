import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .config import settings
from .observability import init_sentry
from .rate_limiter import check_and_set_rate_limit
from .redis_cache import get_last_poll_heartbeat, get_redis
from .scheduler import scheduler, start_scheduler
from .supabase_client import get_service_client
from .sync_service import sync_connection

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("broker_sync")

# As early as possible — before the FastAPI app is even constructed — so
# a failure during construction itself is still captured, not just
# exceptions raised after startup.
init_sentry()


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="VaultPoint Broker Sync", lifespan=lifespan)


async def require_api_key(x_api_key: str = Header(default="")) -> None:
    # Constant-time compare — this guards a real secret, not just a
    # cosmetic check, and it's the only thing standing between the
    # public internet and "force-sync any user_id on demand."
    if not x_api_key or not _constant_time_eq(x_api_key, settings.python_service_api_key):
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


def _constant_time_eq(a: str, b: str) -> bool:
    import hmac as _hmac

    return _hmac.compare_digest(a, b)


# How many missed poll cycles before a stale heartbeat counts as unhealthy.
# >1 so a single slow cycle doesn't flip /health red.
POLL_STALE_MULTIPLIER = 3


@app.get("/health")
async def health():
    checks: dict[str, object] = {}
    healthy = True

    try:
        supabase = get_service_client()
        await asyncio.to_thread(
            lambda: supabase.table("broker_connections").select("id").limit(1).execute()
        )
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {exc}"
        healthy = False

    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {exc}"
        healthy = False

    try:
        last_poll = await get_last_poll_heartbeat()
    except Exception as exc:
        # Same Redis instance as the ping() above, but a distinct failure
        # mode (e.g. ping succeeds, GET fails, or vice versa under partial
        # outages) — checked independently so one doesn't mask the other,
        # and so this can't crash the endpoint into a raw 500 the way an
        # unhandled exception here did before this was wrapped.
        checks["last_successful_poll"] = f"error: {exc}"
        healthy = False
    else:
        checks["last_successful_poll"] = last_poll
        if last_poll is None:
            healthy = False
        else:
            age_seconds = (
                datetime.now(UTC) - datetime.fromisoformat(last_poll)
            ).total_seconds()
            if age_seconds > settings.poll_interval_seconds * POLL_STALE_MULTIPLIER:
                checks["last_successful_poll_stale"] = True
                healthy = False

    return JSONResponse(
        status_code=200 if healthy else 503,
        content={
            "status": "ok" if healthy else "degraded",
            # Railway sets this automatically for GitHub-triggered deploys
            # (see https://docs.railway.com/variables/reference) — not
            # present when running locally/outside Railway, hence the
            # fallback rather than a hard requirement.
            "version": os.environ.get("RAILWAY_GIT_COMMIT_SHA", "unknown"),
            "checks": checks,
        },
    )


@app.post("/sync/{user_id}", dependencies=[Depends(require_api_key)])
async def force_sync(user_id: str):
    allowed = await check_and_set_rate_limit(user_id)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="A sync was already requested for this user in the last minute.",
        )

    supabase = get_service_client()
    result = await asyncio.to_thread(
        lambda: supabase.table("broker_connections")
        .select("*")
        .eq("user_id", user_id)
        .neq("sync_status", "disconnected")
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="No broker connections found for this user.")

    for connection in result.data:
        await sync_connection(connection)

    return {"status": "synced", "connections": len(result.data)}
