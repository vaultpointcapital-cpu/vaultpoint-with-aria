import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, paragraph } from './shared';

export interface OfferNudgeEmailTemplateProps {
  appUrl: string;
  connectUrl: string;
}

/**
 * Sent by POST /api/offers/cron/process, 24h and 72h after a click with no
 * connection yet — same copy for both sends per the spec, distinguished
 * only by nudges_sent (0 -> this send -> 1, 1 -> this send -> 2, capped).
 */
export function OfferNudgeEmailTemplate({ appUrl, connectUrl }: OfferNudgeEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Bought your Hantec account? Connect it to see it in your dashboard.</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>Bought your Hantec account?</Text>
          <Text style={paragraph}>
            Connect it to VaultPoint to automatically track your drawdown, daily loss limit, and challenge
            progress in your dashboard.
          </Text>
          <Section style={buttonSection}>
            <Button style={button} href={connectUrl}>
              Connect your account
            </Button>
          </Section>
          <Text style={paragraph}>
            Haven&apos;t purchased yet? No action needed — this is just a reminder in case you did.
          </Text>
          <Text style={footer}>
            VaultPoint — portfolio and savings tracking. Not investment advice.{' '}
            <a href={appUrl}>{appUrl}</a>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default OfferNudgeEmailTemplate;
