import crypto from 'crypto';

/**
 * A referral state token round-tripped through the outbound partner URL
 * (?vp_ref=) and back through GET /api/offers/return — never manually
 * typed by a user, unlike src/lib/auth/telegram-link.ts's link code, so
 * no need for that code's no-ambiguous-characters alphabet. 24 random
 * bytes (192 bits) base64url-encoded.
 */
export function generateStateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
