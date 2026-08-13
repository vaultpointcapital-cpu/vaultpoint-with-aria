import * as Sentry from '@sentry/nextjs';

export interface SendSlackAlertParams {
  text: string;
  /** Sentry breadcrumb/tag context — which flow this alert belongs to (e.g. "dispute-sla-breach"), not user-identifying data. */
  alertType: string;
}

export interface SendSlackAlertResult {
  success: boolean;
  error?: string;
}

/**
 * No Slack integration exists anywhere else in this codebase — this is
 * the first. Deliberately minimal: a single incoming-webhook POST, no
 * Slack SDK/OAuth app, mirroring src/lib/email/send.ts's sendEmail shape
 * exactly (never throws — a Slack outage must never break whatever flow
 * triggered the alert; logs the full failure to Sentry; returns a plain
 * result rather than requiring the caller to inspect Sentry itself).
 *
 * process.env.SLACK_DISPUTES_WEBHOOK_URL unset is treated as "alerting
 * not configured yet," not an error — same optional-and-degrade pattern
 * every other not-yet-provisioned vendor integration in this codebase
 * uses (e.g. services/broker-sync/app/config.py's resend_api_key).
 */
export async function sendSlackAlert({ text, alertType }: SendSlackAlertParams): Promise<SendSlackAlertResult> {
  const webhookUrl = process.env.SLACK_DISPUTES_WEBHOOK_URL;
  if (!webhookUrl) {
    return { success: false, error: 'SLACK_DISPUTES_WEBHOOK_URL is not configured.' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      Sentry.captureMessage(`Slack webhook send failed: ${alertType}`, {
        level: 'error',
        tags: { alertType },
        extra: { status: response.status, body },
      });
      return { success: false, error: `Slack returned ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    Sentry.captureException(err, { tags: { alertType, source: 'sendSlackAlert' } });
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
