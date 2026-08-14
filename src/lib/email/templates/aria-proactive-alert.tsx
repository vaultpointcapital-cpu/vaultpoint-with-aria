import { Body, Button, Container, Head, Html, Preview, Section, Text } from '@react-email/components';
import { button, buttonSection, container, footer, heading, logo, main, paragraph } from './shared';

export interface AriaProactiveAlertEmailTemplateProps {
  appUrl: string;
  message: string;
}

/**
 * Sent by POST /api/aria/pantheon/proactive-check — the email leg of a
 * Pantheon proactive delivery, paired with an in-app aria_conversations
 * row (see that route for the full delivery logic: warning/critical
 * findings only, batched with a 30-min same-user gap). `message` is
 * Aria's own already-synthesized reply text, not a template — this
 * wrapper only supplies the email chrome around it, same "React template,
 * not a raw string" convention every other transactional email in this
 * codebase uses (see offer-nudge.tsx).
 */
export function AriaProactiveAlertEmailTemplate({ appUrl, message }: AriaProactiveAlertEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>Aria has something for you</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>VaultPoint</Text>
          <Text style={heading}>A note from Aria</Text>
          <Text style={paragraph}>{message}</Text>
          <Section style={buttonSection}>
            <Button style={button} href={`${appUrl}/dashboard/markets`}>
              Open Aria
            </Button>
          </Section>
          <Text style={footer}>
            Aria is an AI assistant, not a licensed financial advisor. Informational only — not financial advice.{' '}
            <a href={appUrl}>{appUrl}</a>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default AriaProactiveAlertEmailTemplate;
