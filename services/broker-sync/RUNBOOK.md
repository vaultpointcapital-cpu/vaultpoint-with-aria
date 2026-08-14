# RUNBOOK — broker-sync on Railway (staging)

This covers the parts of the staging deploy that only a human with
Railway/Supabase dashboard access can do — creating the project, setting
secrets, and confirming the first deploy. Nothing here should ever be
committed to the repo; env vars live in the Railway dashboard only.

Everything in this file targets a **staging** Supabase project and a
**staging** Railway environment. Do not point any of this at the
production Supabase project.

---

## 1. Prerequisite: a staging Supabase project

If it doesn't already exist, create a second Supabase project dedicated
to staging (separate from whatever project the production Next.js app
uses). Run the repo's migrations against it (`supabase/migrations/`)
the same way you did for production. This runbook assumes that project
exists and you have its URL and service-role key on hand.

## 2. Create the Railway project

1. Go to https://railway.app/new
2. Choose **Deploy from GitHub repo**, select this repo.
3. When prompted for a service, Railway will try to detect a root
   Dockerfile — it won't find one at the repo root, since this is a
   monorepo. Cancel the auto-detect and create the service manually if
   asked, or let it create an empty service you'll configure next.

   **Expected result:** a new Railway project with one service, currently
   failing or not yet deployed (no root directory / no source configured
   correctly yet).

## 3. Point the service at services/broker-sync

1. Open the service → **Settings** → **Source**.
2. Set **Root Directory** to `services/broker-sync`.
   This matters because `railway.toml`'s `dockerfilePath = "Dockerfile"`
   is resolved relative to this root directory, not the repo root — if
   you skip this step Railway will look for a Dockerfile at the repo
   root and fail to find one.
3. Under **Settings → Environments**, confirm you're on an environment
   named `staging` (Railway creates `production` by default — rename it
   or add a new one via the environment dropdown at the top of the
   dashboard, "+ New Environment").

   **Expected result:** Settings → Source shows Root Directory =
   `services/broker-sync`, and the environment selector shows `staging`.

## 4. Generate the service-to-service API key

This key is what the Next.js app sends in the `x-api-key` header to
trigger a manual sync — it must match on both sides.

Run this locally (not in any file, not pasted into a chat):

```bash
openssl rand -hex 32
```

**Expected output:** a 64-character hex string, e.g.
`3f2a9c1e...` (64 hex chars total). Copy it — you'll paste it into two
places in steps 5 and 7.

## 5. Set environment variables in the Railway dashboard

Service → **Variables** tab → add each of the following. Never put
these in a file in the repo.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | staging Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | staging project's service-role key (Settings → API) |
| `ENCRYPTION_KEY` | the **staging** encryption key — a 64-char hex string, must match whatever the staging Next.js deployment also uses. Generate a fresh one with `openssl rand -hex 32` if staging doesn't have one yet; do not reuse the production key. |
| `UPSTASH_REDIS_REST_URL` | staging Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | staging Upstash Redis REST token |
| `PYTHON_SERVICE_API_KEY` | the value generated in step 4 |
| `SENTRY_DSN` | (optional) DSN from a Sentry project — recommended for staging so you can see the failure-reporting path work before production |
| `METAAPI_TOKEN` | (optional) only if testing MetaTrader sync in staging |

Leave `POLL_INTERVAL_SECONDS`, `CACHE_TTL_SECONDS`, and
`SYNC_RATE_LIMIT_SECONDS` unset unless you deliberately want to
override the defaults (60s / 55s / 60s) — useful for staging if you
want faster feedback, e.g. `POLL_INTERVAL_SECONDS=20`.

**Expected result:** the Variables tab lists all of the required rows
above with no blank values (optional ones can stay empty).

## 6. Confirm the healthcheck path

`railway.toml` already sets `healthcheckPath = "/health"` and
`healthcheckTimeout = 300`, so Railway should pick this up automatically
from config-as-code. Confirm it took effect: Service → Settings →
Deploy → **Healthcheck Path** should show `/health`. If it's blank,
set it manually to `/health` — this is what Railway polls after each
deploy to decide whether to route traffic to the new instance or roll
back automatically.

## 7. Set PYTHON_SERVICE_API_KEY on the Next.js (staging) side too

The Next.js app's manual-refresh proxy sends this key as `x-api-key`
when calling `POST /sync/{user_id}`. Wherever the staging Next.js app is
deployed (Vercel or elsewhere), set:

- `PYTHON_SERVICE_URL` → this Railway service's public URL (step 8 gives
  you this)
- `PYTHON_SERVICE_API_KEY` → the exact same value from step 4

A mismatch here doesn't error loudly — it just makes every manual
refresh click return 401 from the proxy.

## 8. Deploy

1. Service → **Deployments** tab → trigger a deploy (push to the
   connected branch, or use **Deploy** button to redeploy the latest
   commit).
2. Watch the build logs. First build installs from `requirements.txt`
   into the `python:3.11-slim` image — expect a few minutes.
3. Once built, Railway calls `/health` per `healthcheckPath` before
   marking the deploy healthy.

   **Expected result:** deployment status goes Building → Deploying →
   Active (green). Visiting `https://<your-service>.up.railway.app/health`
   returns JSON with `"status": "healthy"` (or `"degraded"` if e.g. no
   poll cycle has completed yet — that's expected immediately after a
   fresh deploy, it should flip to `healthy` within one
   `POLL_INTERVAL_SECONDS` cycle) and a `"version"` field populated with
   a git SHA (Railway sets `RAILWAY_GIT_COMMIT_SHA` automatically, no
   action needed).

4. Get the public URL: Service → Settings → **Networking** → generate a
   domain if one isn't already assigned. Use this for
   `PYTHON_SERVICE_URL` in step 7.

## 9. Rollback procedure

If a deploy is bad (health checks failing, errors in Sentry, wrong
behavior):

1. Service → **Deployments** tab.
2. Find the last known-good deployment in the list.
3. Click its **⋮** menu → **Redeploy**.

   **Expected result:** Railway rebuilds/reactivates that exact prior
   image and routes traffic to it once its healthcheck passes — no git
   revert needed to recover.

Note: `restartPolicyType = "ON_FAILURE"` with
`restartPolicyMaxRetries = 3` in `railway.toml` already handles crash
loops automatically (3 retries before Railway stops trying) — manual
rollback is for a deploy that's "up" but behaviorally wrong.

---

## 10. Staging smoke test

Run this after step 8's deploy is Active. It exercises the full loop —
insert → poll → decrypt → write positions/snapshots → heartbeat — plus
the manual-sync rate limit and Redis's cache-only self-healing property.

### 10.1 Seed one real broker_connections row

You need a staging `users.id` to attach it to — use an existing staging
test user, or create one via Supabase Auth admin API / dashboard first.

From `services/broker-sync/`, with the staging env vars exported locally
(same `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `ENCRYPTION_KEY`
values you put in Railway — export them in your shell for this one
command, don't write them to a file):

```bash
python scripts/staging_seed_connection.py --user-id <staging-user-uuid> --broker bybit --label "Smoke test"
```

You'll be prompted to type `staging` to confirm the target project, then
for the API key and secret via a hidden prompt (use real, read-only
Bybit testnet or low-privilege keys — never a key with withdrawal
permission, per the platform's `is_read_only` design).

**Expected output:** `Inserted broker_connections row: <uuid> (broker=bybit, user_id=...)`
— no key/secret value printed anywhere in the output.

### 10.2 Watch one poll cycle

Tail the Railway service logs (Service → Deployments → View Logs) and
wait up to `POLL_INTERVAL_SECONDS` (60s default).

**Expected result:**
- A log line for the poll cycle start and a "finished in Xs" line
  (from `scheduler.py`'s timing wrapper).
- In staging Supabase: `select * from positions where user_id = '<uuid>'`
  returns rows (or zero rows if the seeded account genuinely holds no
  positions — check `portfolio_snapshots` too in that case).
- `select * from portfolio_snapshots where user_id = '<uuid>' order by created_at desc limit 1`
  returns a fresh row.
- `GET /health` on the Railway URL shows `"last_successful_poll"` as a
  recent timestamp and `"status": "healthy"`.

### 10.3 Manual sync + rate limit

```bash
curl -i -X POST https://<your-service>.up.railway.app/sync/<staging-user-uuid> \
  -H "x-api-key: <PYTHON_SERVICE_API_KEY from step 4>"
```

**Expected result:** `200` on the first call. Repeat immediately —
**expected: `429`** within the next `SYNC_RATE_LIMIT_SECONDS` (60s
default), confirming the per-user rate limit (`app/rate_limiter.py`) is
active in staging, not just in tests.

### 10.4 Redis self-heal

Flush the staging Upstash database (Upstash dashboard → Data Browser →
Flush, or `redis-cli` against it if you have TCP access) while the
service keeps running — do not redeploy or restart the service.

**Expected result:** the next scheduled poll cycle (within
`POLL_INTERVAL_SECONDS`) completes normally and re-populates the cache
and heartbeat with no errors and no manual intervention. Redis here is
cache-only — every read path that depends on it (poll lock, rate
limiter, heartbeat) is designed to reacquire/rebuild its state from a
clean slate. If a cycle instead errors or the service crashes after the
flush, that is a real bug (something is treating a Redis key as a
source of truth rather than a cache), not an expected transient.

---

## Things this runbook cannot verify for you

- The Dockerfile has not been build-tested locally (no Docker in the
  environment this was written in) — the first real signal on whether
  it builds cleanly is Railway's own build log in step 8.
- Steps 2, 3, 6, 8's dashboard UI details (button names, tab layout)
  are based on Railway's current docs/UI as of when this was written
  and may drift if Railway changes their dashboard.
- Whether a staging Supabase project already exists (step 1) — this
  runbook assumes it does or that you'll create one first.
- Step 10 end-to-end: there's no staging Railway deployment or staging
  Supabase project in this environment, so the smoke test in step 10
  is a verified *procedure* (the seed script's encryption was round-trip
  tested against the service's own `decrypt()` locally, and the rate
  limiter / poll lock / heartbeat logic each have passing unit tests),
  not something run against a live staging deploy by me. You'll need to
  actually execute step 10 yourself once steps 1-9 are done, and report
  back if any expected result doesn't match.
