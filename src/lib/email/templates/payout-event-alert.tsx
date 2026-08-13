import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, paragraph } from './shared';

export interface PayoutEventAlertEmailTemplateProps {
  appUrl: string;
  withdrawalEventId: string;
  summary: string;
}

/**
 * Internal ops alert, not user-facing — sent to every new withdrawal_event
 * regardless of confidence (Automated Profit-Split Payout Calculation spec,
 * section 3.3: "Founder/ops notification on every new withdrawal event,
 * regardless of confidence level, for the current team size"). Paired
 * with a Slack message via src/lib/slack/send.ts. Mirrors
 * dispute-alert.tsx's shape exactly.
 */
export function PayoutEventAlertEmailTemplate({ appUrl, withdrawalEventId, summary }: PayoutEventAlertEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>A withdrawal was detected</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>A withdrawal was detected</Text>
          <Text style={paragraph}>{summary}</Text>
          <Section style={buttonSection}>
            <Button style={button} href={`${appUrl}/dashboard/admin/payouts?event=${withdrawalEventId}`}>
              Review
            </Button>
          </Section>
          <Text style={footer}>Internal alert — Automated Profit-Split Payout Calculation.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default PayoutEventAlertEmailTemplate;
