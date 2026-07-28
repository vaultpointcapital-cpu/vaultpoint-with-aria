import { type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/rate-limit';
import { checkAndRecordLoginDevice, LOGIN_DEVICE_COOKIE, LOGIN_DEVICE_COOKIE_MAX_AGE } from '@/lib/auth/login-alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/login-device
 *
 * Step-Up Auth Ticket 6. Called by src/app/(auth)/login/page.tsx right
 * after supabase.auth.signInWithPassword() succeeds — the closest thing
 * to a server-side "session created" hook the password login flow has,
 * since that call happens entirely client-side (see the migration's own
 * comment for why). A failed call here must never block the login
 * itself, same "never break the actual flow" rule signup's Resend send
 * and GET /auth/callback's welcome email both already follow.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user || !authData.user.email) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const cookieStore = cookies();
  const existingFingerprint = cookieStore.get(LOGIN_DEVICE_COOKIE)?.value ?? null;

  try {
    const result = await checkAndRecordLoginDevice({
      userId: authData.user.id,
      userEmail: authData.user.email,
      existingFingerprint,
      userAgent: request.headers.get('user-agent'),
      ip: getClientIp(request),
      appUrl: request.nextUrl.origin,
    });

    const response = apiSuccess({ new_device: result.isNewDevice });
    response.cookies.set(LOGIN_DEVICE_COOKIE, result.fingerprint, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: LOGIN_DEVICE_COOKIE_MAX_AGE,
      path: '/',
    });
    return response;
  } catch (err) {
    console.error('[auth/login-device] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not record this login.');
  }
}
