import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .config import settings
from .observability import init_sentry
from .rate_limiter import check_and_set_rate_limit
from .redis_cache import get_last_poll_heartbeat, get_redis
from .scheduler import scheduler, start_scheduler
from .signal_execution import SignalExecutionError, execute_signal
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


class ExecuteSignalRequest(BaseModel):
    user_id: str
    broker_connection_id: str
    size: float


@app.post("/signals/{signal_id}/execute", dependencies=[Depends(require_api_key)])
async def execute_signal_endpoint(signal_id: str, body: ExecuteSignalRequest):
    """Called by the Next.js app's own POST /api/signals/[id]/execute
    route (never directly by a browser — same x-api-key trust boundary
    as /sync/{user_id}). Records the signal_actions row itself, on
    either outcome, so the caller doesn't need a second round-trip: a
    failed order is still an audited action, per Signal Mode's
    acceptance criteria ("full audit log of every action taken").
    """
    supabase = get_service_client()

    try:
        order_id = await execute_signal(
            user_id=body.user_id,
            signal_id=signal_id,
            broker_connection_id=body.broker_connection_id,
            size=body.size,
        )
    except SignalExecutionError as exc:
        # exc's own name is deleted by Python at the end of this except
        # block, so it can't be safely referenced inside the lambda below
        # (pyflakes flags this correctly as F821) — captured into a plain
        # local first instead.
        failure_reason = str(exc)[:500]
        await asyncio.to_thread(
            lambda: supabase.table("signal_actions")
            .insert(
                {
                    "signal_id": signal_id,
                    "user_id": body.user_id,
                    "broker_connection_id": body.broker_connection_id,
                    "action": "failed",
                    "executed_size": body.size,
                    "failure_reason": failure_reason,
                }
            )
            .execute()
        )
        raise HTTPException(status_code=422, detail=failure_reason) from exc

    result = await asyncio.to_thread(
        lambda: supabase.table("signal_actions")
        .insert(
            {
                "signal_id": signal_id,
                "user_id": body.user_id,
                "broker_connection_id": body.broker_connection_id,
                "action": "executed",
                "executed_size": body.size,
                "broker_order_id": order_id,
            }
        )
        .execute()
    )
    return {"status": "executed", "broker_order_id": order_id, "signal_action_id": result.data[0]["id"]}
