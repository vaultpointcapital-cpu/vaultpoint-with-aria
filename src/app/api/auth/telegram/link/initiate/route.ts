import { createClient } from '@/lib/supabase/server';
import { initiateTelegramLink } from '@/lib/auth/telegram-link';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/telegram/link/initiate
 *
 * Step-Up Auth Ticket 4. Returns a short-lived code the client shows the
 * user (e.g. "Send /link ABCD1234 to @VaultPointBot"). Completed by
 * POST /api/webhooks/telegram/updates when that message arrives.
 */
export async function POST() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  try {
    const result = await initiateTelegramLink(authData.user.id);
    return apiSuccess({ code: result.code, expires_at: result.expiresAt }, 201);
  } catch (err) {
    console.error('[auth/telegram/link/initiate] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not start Telegram linking.');
  }
}
