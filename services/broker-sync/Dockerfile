# VaultPoint broker-sync — production image.
#
# Not locally build-tested (no Docker available in the environment this
# was written in) — verify the first build in Railway itself, or with
# `docker build .` locally before relying on this for a real deploy.

FROM python:3.11-slim

# Runs as a dedicated non-root user — this service holds
# SUPABASE_SERVICE_ROLE_KEY and ENCRYPTION_KEY in its environment and
# decrypts broker credentials in memory; root inside the container buys
# nothing here and only widens the blast radius of a dependency RCE.
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --create-home --shell /bin/bash appuser

WORKDIR /app

# Dependencies installed before app code so Docker's layer cache is only
# invalidated by requirements.txt changing, not every code edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

RUN chown -R appuser:appuser /app
USER appuser

# Railway injects PORT at runtime and routes traffic to it — must bind
# 0.0.0.0 (not 127.0.0.1/localhost) or the platform can't reach the
# process at all. sh -c so $PORT actually expands; uvicorn's CLI doesn't
# read env vars for --host/--port itself. 8000 is only the documented
# fallback for running this image outside Railway.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
