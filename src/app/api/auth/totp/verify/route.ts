import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { verifyTotpEnrollmentSchema } from '@/lib/validations/totp';
import { verifyTotpEnrollment } from '@/lib/auth/totp-enrollment';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/totp/verify
 *
 * Step-Up Auth Ticket 3. Confirms a pending enrollment by checking a
 * real code from the authenticator app — proves possession of the
 * secret, not just that the user clicked through the QR screen. Once
 * active, this same enrollment is what makes 'totp' show up in a step-up
 * approval's offered methods (src/lib/auth/step-up.ts's initiateStepUp).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = verifyTotpEnrollmentSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid code.', parsed.error.flatten());
  }

  try {
    const outcome = await verifyTotpEnrollment({ userId: authData.user.id, code: parsed.data.code });

    if (outcome === 'not_enrolled') {
      return apiError('NOT_FOUND', 'No TOTP enrollment in progress. Start with POST /api/auth/totp/enroll.');
    }
    if (outcome === 'invalid_code') {
      return apiError('VALIDATION_ERROR', 'That code is incorrect or expired.');
    }

    return apiSuccess({ status: outcome });
  } catch (err) {
    console.error('[auth/totp/verify] error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not verify this code.');
  }
}
