import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, muted, paragraph } from './shared';

export interface NewDeviceLoginTemplateProps {
  appUrl: string;
  ip: string;
  userAgent: string | null;
}

/**
 * Sent once per newly-recognized browser (src/lib/auth/login-alerts.ts),
 * never on a login from an already-known device. No exact location
 * lookup — this codebase has no geo-IP service wired up anywhere — the
 * raw IP and user agent are shown as-is rather than a guessed city/ISP
 * that could be wrong.
 */
export function NewDeviceLoginTemplate({ appUrl, ip, userAgent }: NewDeviceLoginTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>New login to your VaultPoint account</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>New login detected</Text>
          <Text style={paragraph}>
            We noticed a login to your VaultPoint account from a device we haven&apos;t seen before.
          </Text>
          <Text style={paragraph}>
            IP address: {ip}
            <br />
            Device: {userAgent ?? 'unknown'}
          </Text>
          <Text style={paragraph}>If this was you, no action is needed.</Text>
          <Section style={buttonSection}>
            <Button style={button} href={`${appUrl}/reset-password`}>
              Wasn&apos;t you? Reset your password
            </Button>
          </Section>
          <Text style={muted}>If you didn&apos;t request this and don&apos;t recognize this activity, reset your password now.</Text>
          <Text style={footer}>VaultPoint — portfolio and savings tracking. Not investment advice.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default NewDeviceLoginTemplate;
