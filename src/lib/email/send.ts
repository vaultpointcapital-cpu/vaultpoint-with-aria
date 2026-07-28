import * as Sentry from '@sentry/nextjs';
import type { ReactElement } from 'react';
import { getResendClient } from '@/lib/email/client';
import { EMAIL_FROM, EMAIL_REPLY_TO } from '@/lib/email/config';

export interface SendEmailParams {
  to: string;
  subject: string;
  react: ReactElement;
  /** Sentry breadcrumb/tag context — which flow this email belongs to (e.g. "verify-email", "welcome"), not user-identifying data. */
  emailType: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * The one place every transactional email actually gets sent through
 * Resend. Never throws — a Resend failure must never break whatever
 * calling flow triggered the email (signup, confirmation) per Phase 1's
 * own requirement. Logs the FULL Resend API response on failure to
 * Sentry (never just a generic message — this is exactly the "errors
 * being swallowed" complaint that started this work), and returns a
 * plain success/failure result so the caller can decide what to do next
 * (e.g. set a retry flag) without needing to inspect Sentry itself.
 */
export async function sendEmail({ to, subject, react, emailType }: SendEmailParams): Promise<SendEmailResult> {
  try {
    const resend = getResendClient();
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject,
      react,
      replyTo: EMAIL_REPLY_TO,
    });

    if (error) {
      Sentry.captureMessage(`Resend send failed: ${emailType}`, {
        level: 'error',
        tags: { emailType },
        extra: { resendError: error },
      });
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    Sentry.captureException(err, { tags: { emailType, source: 'sendEmail' } });
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
