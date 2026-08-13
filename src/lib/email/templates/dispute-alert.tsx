import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, paragraph } from './shared';

export interface DisputeAlertEmailTemplateProps {
  appUrl: string;
  disputeId: string;
  reason: 'sla_breach' | 'performance_category';
  summary: string;
}

const REASON_HEADING: Record<DisputeAlertEmailTemplateProps['reason'], string> = {
  sla_breach: 'A dispute has breached its SLA',
  performance_category: 'A performance dispute was opened',
};

/**
 * Internal ops alert, not user-facing — sent to DISPUTES_ALERT_EMAIL by
 * either app/api/disputes/cron/sla-check (SLA breach) or POST /api/disputes
 * itself (category='performance' on a managed account, same-day
 * visibility rule per the escalation spec section 4). Paired with a Slack
 * message via src/lib/slack/send.ts — this is the redundant channel for
 * whoever isn't watching Slack at the moment.
 */
export function DisputeAlertEmailTemplate({ appUrl, disputeId, reason, summary }: DisputeAlertEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>{REASON_HEADING[reason]}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>{REASON_HEADING[reason]}</Text>
          <Text style={paragraph}>{summary}</Text>
          <Section style={buttonSection}>
            <Button style={button} href={`${appUrl}/dashboard/admin/disputes/${disputeId}`}>
              Open dispute
            </Button>
          </Section>
          <Text style={footer}>
            Internal alert — Managed Account Dispute & Escalation Policy.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default DisputeAlertEmailTemplate;
