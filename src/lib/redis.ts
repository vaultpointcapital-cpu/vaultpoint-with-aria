import { Redis } from '@upstash/redis';

/**
 * The same Upstash instance the Python broker-sync service already uses
 * (UPSTASH_REDIS_REST_URL/_TOKEN) — one shared Redis, not a second one
 * to provision. Shared by src/lib/rate-limit.ts and
 * GET /api/health so both talk to the same client rather than each
 * instantiating their own.
 *
 * Null when either env var is unset (e.g. local dev without Upstash
 * configured) rather than throwing at import time — every caller
 * handles the null case explicitly (rate-limit fails open, health
 * reports the check as unconfigured rather than crashing the route).
 */
export const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;
