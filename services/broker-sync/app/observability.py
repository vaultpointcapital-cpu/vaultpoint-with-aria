import os

import sentry_sdk

from .config import settings


def init_sentry() -> None:
    """No-op when SENTRY_DSN isn't set — every sentry_sdk.capture_*() call
    elsewhere in this service is then also a no-op (that's the SDK's own
    documented behavior for an uninitialized client), so nothing else
    needs an `if settings.sentry_dsn` guard around it.

    Call this once, as early as possible — before app = FastAPI(...) in
    main.py — so an exception during app construction itself would still
    be captured, not just exceptions raised after startup.
    """
    if not settings.sentry_dsn:
        return

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        # This service is a scheduler + a couple of low-traffic endpoints,
        # not something worth performance tracing — error reporting only.
        traces_sample_rate=0.0,
        environment=os.environ.get("RAILWAY_ENVIRONMENT_NAME", "development"),
        release=os.environ.get("RAILWAY_GIT_COMMIT_SHA"),
    )
