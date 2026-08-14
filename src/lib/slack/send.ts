import * as Sentry from '@sentry/nextjs';

export interface SendSlackAlertParams {
  text: string;
  /** Incoming webhook URL to POST to — the caller's own env var (e.g. SLACK_DISPUTES_WEBHOOK_URL, SLACK_PAYOUTS_WEBHOOK_URL), not read from here. Undefined is treated as "not configured," not an error. */
  webhookUrl: string | undefined;
  /** Sentry breadcrumb/tag context — which flow this alert belongs to (e.g. "dispute-sla-breach", "payout-withdrawal-detected"), not user-identifying data. */
  alertType: string;
}

export interface SendSlackAlertResult {
  success: boolean;
  error?: string;
}

/**
 * No Slack integration exists anywhere else in this codebase — this is
 * the first, built for the dispute-escalation feature and reused as-is
 * (not dispute-specific) for the payout-calculation feature. Deliberately
 * minimal: a single incoming-webhook POST, no Slack SDK/OAuth app,
 * mirroring src/lib/email/send.ts's sendEmail shape exactly (never
 * throws — a Slack outage must never break whatever flow triggered the
 * alert; logs the full failure to Sentry; returns a plain result rather
 * than requiring the caller to inspect Sentry itself).
 *
 * Takes webhookUrl as a parameter rather than reading one fixed env var
 * internally — each feature (disputes, payouts, ...) may post to a
 * different Slack channel, so each feature's own alert-dispatch module
 * (src/lib/disputes/alerts.ts, src/lib/payouts/alerts.ts) reads its own
 * env var and passes it in. An unset value is "alerting not configured
 * yet for this feature," not an error — same optional-and-degrade
 * pattern every other not-yet-provisioned vendor integration in this
 * codebase uses (e.g. services/broker-sync/app/config.py's resend_api_key).
 */
export async function sendSlackAlert({ text, webhookUrl, alertType }: SendSlackAlertParams): Promise<SendSlackAlertResult> {
  if (!webhookUrl) {
    return { success: false, error: 'No Slack webhook URL configured for this alert type.' };
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
