import { Ratelimit } from '@upstash/ratelimit';
import { redis } from '@/lib/redis';

/**
 * Every limiter below is null when Upstash isn't configured (see
 * lib/redis.ts), and checkRateLimit() fails OPEN when a limiter is null
 * — rate limiting is a hardening layer, not the primary authorization
 * boundary, and a misconfigured or temporarily-unreachable Redis must
 * never be able to take down signup or any other route entirely.
 */

/**
 * Stricter limiter for signup and confirmation-resend — both are rare,
 * legitimate actions for a real user (you sign up once; you resend a
 * confirmation email a handful of times at most). Tight limits here
 * mostly block abuse: account-creation spam, or email-bombing a target
 * inbox via repeated resend requests.
 */
export const authRateLimit = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'ratelimit:auth' })
  : null;

/** Default limiter for other unauthenticated/public API routes. */
export const publicApiRateLimit = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'ratelimit:public' })
  : null;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export async function checkRateLimit(limiter: Ratelimit | null, identifier: string): Promise<RateLimitResult> {
  if (!limiter) {
    return { allowed: true };
  }

  const result = await limiter.limit(identifier);
  if (result.success) {
    return { allowed: true };
  }

  const retryAfterSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
  return { allowed: false, retryAfterSeconds };
}

/**
 * Vercel sets x-forwarded-for on every request; the constant fallback
 * means a missing header degrades to "everyone shares one bucket"
 * rather than throwing — a legitimate, if coarse, rate limit is better
 * than none.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
}
