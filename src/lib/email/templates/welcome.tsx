import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, paragraph } from './shared';

export interface WelcomeEmailTemplateProps {
  appUrl: string;
  fullName?: string | null;
}

/**
 * Sent once, from GET /auth/callback, the first time a user's email is
 * confirmed — not at signup time, since "welcome" only makes sense once
 * the account is actually usable.
 */
export function WelcomeEmailTemplate({ appUrl, fullName }: WelcomeEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Your VaultPoint account is ready</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>You&apos;re in</Text>
          <Text style={paragraph}>{fullName ? `Hi ${fullName},` : 'Hi,'}</Text>
          <Text style={paragraph}>
            Your email is confirmed and your VaultPoint account is ready. Connect a broker to start tracking your
            portfolio, set up savings goals, and follow market alerts — all in one place.
          </Text>
          <Section style={buttonSection}>
            <Button style={button} href={`${appUrl}/dashboard`}>
              Go to dashboard
            </Button>
          </Section>
          <Text style={paragraph}>
            VaultPoint is a tracking tool — it never holds your funds and never executes trades on your behalf.
          </Text>
          <Text style={footer}>VaultPoint — portfolio and savings tracking. Not investment advice.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default WelcomeEmailTemplate;
