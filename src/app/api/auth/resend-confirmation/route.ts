import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/send';
import { VerifyEmailTemplate } from '@/lib/email/templates/verify-email';
import { authRateLimit, checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const resendConfirmationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

/**
 * POST /api/auth/resend-confirmation
 * The retry path for confirmation_email_pending_retry (see
 * 20260720000000_add_email_confirmation_retry_flag.sql) — also usable
 * by a user who just wants another copy of the link, not only ones the
 * signup route flagged as failed.
 *
 * Uses generateLink({ type: 'magiclink' }) rather than re-running
 * type: 'signup' — the signup type requires a password parameter, and
 * this route has no business touching a password the user already set;
 * a magic link needs only the email, and clicking it both verifies the
 * address and signs the user in, which is a strictly better resend UX
 * than making them click-to-verify and then log in separately.
 *
 * Always returns a generic success response regardless of whether the
 * email exists or is already confirmed — same email-enumeration
 * reasoning as the password-reset flow already in this codebase.
 */
export async function POST(request: NextRequest) {
  const { allowed, retryAfterSeconds } = await checkRateLimit(authRateLimit, `resend-confirmation:${getClientIp(request)}`);
  if (!allowed) {
    return apiError('RATE_LIMITED', `Too many attempts. Try again in ${retryAfterSeconds}s.`);
  }

  const body = await request.json().catch(() => null);
  const parsed = resendConfirmationSchema.safeParse(body);

  if (!parsed.success) {
    return apiSuccess({ sent: true });
  }

  const { email } = parsed.data;
  const origin = request.nextUrl.origin;
  const supabase = createServiceClient();

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${origin}/auth/callback` },
  });

  if (!error && data.properties?.action_link) {
    const { data: profile } = await supabase.from('users').select('full_name').eq('id', data.user.id).single();

    const emailResult = await sendEmail({
      to: email,
      subject: 'Confirm your VaultPoint email address',
      react: VerifyEmailTemplate({ actionLink: data.properties.action_link, fullName: profile?.full_name }),
      emailType: 'resend-confirmation',
    });

    if (emailResult.success) {
      await supabase.from('users').update({ confirmation_email_pending_retry: false }).eq('id', data.user.id);
    }
  }

  // Deliberately the same response whether or not a user was found,
  // whether the send succeeded, or whether generateLink errored (e.g.
  // "Signups not allowed" for a non-existent email) — never surface any
  // of that to the caller.
  return apiSuccess({ sent: true });
}
