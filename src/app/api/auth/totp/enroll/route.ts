import { createClient } from '@/lib/supabase/server';
import { enrollTotp } from '@/lib/auth/totp-enrollment';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/totp/enroll
 *
 * Step-Up Auth Ticket 3. Issues a new pending secret and returns the
 * otpauth:// URI + base32 secret — QR rendering itself is a frontend
 * concern (no step-up UI has been built in this codebase yet, same as
 * Tickets 1/2/6: backend only). Not usable for step-up until
 * POST /api/auth/totp/verify confirms the authenticator app actually has
 * this secret.
 */
export async function POST() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user || !authData.user.email) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  try {
    const result = await enrollTotp({ userId: authData.user.id, userEmail: authData.user.email });
    return apiSuccess({ otpauth_url: result.otpauthUrl, secret: result.secretBase32 }, 201);
  } catch (err) {
    console.error('[auth/totp/enroll] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not start TOTP enrollment.');
  }
}
