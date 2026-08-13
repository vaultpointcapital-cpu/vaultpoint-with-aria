import { sendEmail } from '@/lib/email/send';
import { DisputeAlertEmailTemplate } from '@/lib/email/templates/dispute-alert';
import { sendSlackAlert } from '@/lib/slack/send';

/**
 * Single funnel point for every dispute alert (SLA breach, same-day
 * performance-category) — both Slack and email, same "one shared
 * write/send path, not each caller re-implementing it" convention as
 * app/pantheon/dedup.py's upsert_finding() on the Python side. Never
 * throws — matches sendEmail/sendSlackAlert's own "always return a
 * result" shape; a notification failure must never break the dispute
 * flow that triggered it (filing a dispute, or the SLA cron marking
 * other disputes).
 */
export async function sendDisputeAlert(params: {
  disputeId: string;
  reason: 'sla_breach' | 'performance_category';
  summary: string;
}): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  await sendSlackAlert({
    text: `:rotating_light: ${params.summary}\n${appUrl}/dashboard/admin/disputes/${params.disputeId}`,
    alertType: `dispute-${params.reason}`,
  });

  const alertEmail = process.env.DISPUTES_ALERT_EMAIL;
  if (alertEmail) {
    await sendEmail({
      to: alertEmail,
      subject:
        params.reason === 'sla_breach' ? 'VaultPoint: dispute SLA breached' : 'VaultPoint: performance dispute opened',
      react: DisputeAlertEmailTemplate({
        appUrl,
        disputeId: params.disputeId,
        reason: params.reason,
        summary: params.summary,
      }),
      emailType: `dispute-${params.reason}`,
    });
  }
}
