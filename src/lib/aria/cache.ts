import { redis } from '@/lib/redis';
import type { AriaContext } from '@/lib/aria/types';

// Aria Context Builder §7 — 60s TTL, matched to the Python poller's
// interval so Aria is never fresher or staler than the dashboard.
const TTL_SECONDS = 60;

function cacheKey(userId: string): string {
  return `aria:ctx:${userId}`;
}

/**
 * This is the first TS-side Redis write in this codebase — every prior
 * usage (rate-limit.ts, fx.ts) only ever read a key Python already
 * wrote. Follows redis.ts's own null-guard idiom exactly: a cache miss
 * (including "Redis isn't configured at all") is just a cache miss,
 * never a thrown error — buildAriaContext() always has a DB-backed path
 * that works with or without Redis.
 */
export async function getCachedAriaContext(userId: string): Promise<AriaContext | null> {
  if (!redis) return null;
  const cached = await redis.get<AriaContext>(cacheKey(userId));
  return cached ?? null;
}

export async function setCachedAriaContext(userId: string, ctx: AriaContext): Promise<void> {
  if (!redis) return;
  await redis.set(cacheKey(userId), ctx, { ex: TTL_SECONDS });
}

/**
 * Called from every TS-side write that changes what Aria would report
 * (new broker connection, pod contribution, manual asset change,
 * broker disconnect) — see the call sites in POST /api/brokers, DELETE
 * /api/brokers/[id], POST /api/pods/[id]/contribute, POST
 * /api/manual-assets. The Python side has its own mirror,
 * invalidate_aria_context() in services/broker-sync/app/redis_cache.py,
 * called on a real connection health transition — same Upstash
 * instance, confirmed via the existing shared fx:{currency} key, so a
 * direct DEL from either runtime evicts what the other would read.
 */
export async function invalidateAriaContext(userId: string): Promise<void> {
  if (!redis) return;
  await redis.del(cacheKey(userId));
}
