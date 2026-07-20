import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, muted, paragraph } from './shared';

export interface VerifyEmailTemplateProps {
  actionLink: string;
  fullName?: string | null;
}

/**
 * Sent from POST /api/auth/signup immediately after account creation —
 * see that route's own comment for why this is sent by application code
 * via Resend rather than Supabase's own built-in auto-mailer.
 */
export function VerifyEmailTemplate({ actionLink, fullName }: VerifyEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Confirm your email to finish setting up VaultPoint</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>Confirm your email address</Text>
          <Text style={paragraph}>{fullName ? `Hi ${fullName},` : 'Hi,'}</Text>
          <Text style={paragraph}>
            Confirm your email address to finish setting up your VaultPoint account and sign in.
          </Text>
          <Section style={buttonSection}>
            <Button style={button} href={actionLink}>
              Verify email address
            </Button>
          </Section>
          <Text style={paragraph}>Or paste this link into your browser:</Text>
          <Text style={{ ...paragraph, wordBreak: 'break-all' as const, fontSize: '13px', color: '#6C63FF' }}>
            {actionLink}
          </Text>
          <Text style={muted}>
            If you didn&apos;t create a VaultPoint account, you can safely ignore this email — no account will be
            activated without confirming this link.
          </Text>
          <Text style={footer}>VaultPoint — portfolio and savings tracking. Not investment advice.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default VerifyEmailTemplate;
