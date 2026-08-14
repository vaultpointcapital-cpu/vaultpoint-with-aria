import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/server';
import { signupSchema } from '@/lib/validations/auth';
import { sendEmail } from '@/lib/email/send';
import { VerifyEmailTemplate } from '@/lib/email/templates/verify-email';
import { authRateLimit, checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/auth/signup
 *
 * Signup used to call supabase.auth.signUp() directly from the client,
 * which relies entirely on Supabase's own built-in auto-mailer for the
 * confirmation email — a system with no visibility from this codebase at
 * all (no error surfaces back to the client if that send fails, no
 * message ID, no retry path, no custom template). That's the real
 * "errors being swallowed" mechanism, not a bug in any Resend call —
 * there was no Resend call for this flow before this route existed.
 *
 * This route creates the account via the service-role admin API's
 * generateLink() — which creates the auth.users row (firing the same
 * handle_new_user() trigger signUp() would) and returns a verification
 * URL WITHOUT Supabase auto-sending anything — then sends that link
 * itself via Resend with a real branded template. account creation and
 * email delivery are two separate steps on purpose: a Resend failure
 * here must never undo the account (see sendEmail's own never-throws
 * contract) — it only flips confirmation_email_pending_retry so
 * POST /api/auth/resend-confirmation can retry it later.
 */
export async function POST(request: NextRequest) {
  const { allowed, retryAfterSeconds } = await checkRateLimit(authRateLimit, `signup:${getClientIp(request)}`);
  if (!allowed) {
    return apiError('RATE_LIMITED', `Too many signup attempts. Try again in ${retryAfterSeconds}s.`);
  }

  const body = await request.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid signup data.', parsed.error.flatten());
  }

  const { fullName, email, password } = parsed.data;
  const origin = request.nextUrl.origin;
  const supabase = createServiceClient();

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'signup',
    email,
    password,
    options: {
      data: { full_name: fullName },
      redirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    // Supabase's admin API error messages are safe to relay directly to
    // the client — same "already safe to show" reasoning the old
    // client-side signUp() call relied on (e.g. "A user with this email
    // address has already been registered").
    return apiError('VALIDATION_ERROR', error.message);
  }

  const actionLink = data.properties.action_link;
  const userId = data.user.id;

  const emailResult = await sendEmail({
    to: email,
    subject: 'Confirm your VaultPoint email address',
    react: VerifyEmailTemplate({ actionLink, fullName }),
    emailType: 'verify-email',
  });

  if (!emailResult.success) {
    const { error: updateError } = await supabase
      .from('users')
      .update({ confirmation_email_pending_retry: true })
      .eq('id', userId);

    if (updateError) {
      // The account and the auth link both still exist — a human
      // reading Sentry can resend manually even if this specific flag
      // write failed. Never let this secondary failure change the
      // response the client gets; account creation already succeeded.
      Sentry.captureException(updateError, { tags: { source: 'signup-retry-flag' } });
    }
  }

  return apiSuccess({ created: true }, 201);
}
