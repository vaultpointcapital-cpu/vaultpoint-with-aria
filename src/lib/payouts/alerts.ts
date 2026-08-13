import { sendEmail } from '@/lib/email/send';
import { PayoutEventAlertEmailTemplate } from '@/lib/email/templates/payout-event-alert';
import { sendSlackAlert } from '@/lib/slack/send';

/**
 * Founder/ops notification on every new withdrawal_event, regardless of
 * confidence (spec section 3.3) — reuses the already-generic
 * sendSlackAlert (src/lib/slack/send.ts, built for the dispute-escalation
 * feature but not dispute-specific) plus a dedicated email template.
 * Never throws — a notification failure must never block detection or
 * split calculation, both of which already completed by the time this
 * is called.
 */
export async function sendPayoutAlert(params: { withdrawalEventId: string; summary: string }): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  await sendSlackAlert({
    text: `:moneybag: ${params.summary}\n${appUrl}/dashboard/admin/payouts`,
    webhookUrl: process.env.SLACK_PAYOUTS_WEBHOOK_URL,
    alertType: 'payout-withdrawal-detected',
  });

  const alertEmail = process.env.PAYOUTS_ALERT_EMAIL;
  if (alertEmail) {
    await sendEmail({
      to: alertEmail,
      subject: 'VaultPoint: withdrawal detected',
      react: PayoutEventAlertEmailTemplate({
        appUrl,
        withdrawalEventId: params.withdrawalEventId,
        summary: params.summary,
      }),
      emailType: 'payout-withdrawal-detected',
    });
  }
}
