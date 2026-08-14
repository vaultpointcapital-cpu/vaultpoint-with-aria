import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { registerDeviceSchema } from '@/lib/validations/devices';
import { registerDevice } from '@/lib/auth/devices';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/devices/register
 *
 * Step-Up Auth Ticket 1. Path adapted from the spec's /auth/devices/register
 * to this codebase's actual routing convention — every API route in this
 * app lives under src/app/api/, there is no bare /auth/* route space.
 *
 * NOT wired to actually send a push yet — no APNs/FCM credentials exist
 * anywhere in this codebase (checked .env.example before starting this
 * ticket, per the ticket's own "blocker check first" instruction). This
 * only registers and encrypts the token so the send-side work has
 * somewhere real to read from once those credentials exist.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = registerDeviceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid device registration.', parsed.error.flatten());
  }

  try {
    const { deviceId } = await registerDevice({
      userId: authData.user.id,
      deviceToken: parsed.data.device_token,
      platform: parsed.data.platform,
    });
    return apiSuccess({ device_id: deviceId }, 201);
  } catch (err) {
    console.error('[auth/devices/register] Registration error:', err instanceof Error ? err.message : err);
    return apiError('INTERNAL_ERROR', 'Could not register this device.');
  }
}
