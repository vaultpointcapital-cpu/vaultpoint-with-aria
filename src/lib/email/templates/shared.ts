/**
 * Shared inline styles for every email template. Light background by
 * design, not dark — email clients' dark-mode support is inconsistent
 * (some auto-invert, some ignore prefers-color-scheme entirely, some
 * partially apply it), so a light base with the brand accent (#6C63FF)
 * used deliberately is the only approach that reliably "renders fine in
 * light-mode clients" while still reading as on-brand. React Email
 * renders everything to inline styles + table-based layout under the
 * hood regardless of how these are written, which is what actually
 * makes this safe across Gmail/Outlook/Apple Mail.
 *
 * Font stack: 'Space Grotesk' first for the rare client that happens to
 * have it, Helvetica/Arial/sans-serif fallback for everyone else — no
 * @font-face embedding attempted, email client web-font support is too
 * inconsistent to rely on.
 */
export const HEADING_FONT = "'Space Grotesk', Helvetica, Arial, sans-serif";
export const BODY_FONT = "Helvetica, Arial, sans-serif";
export const ACCENT = '#6C63FF';

export const main = {
  backgroundColor: '#f4f4f7',
  fontFamily: BODY_FONT,
  padding: '32px 0',
};

export const container = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  margin: '0 auto',
  padding: '40px',
  maxWidth: '480px',
  border: '1px solid #e5e5ec',
};

export const logo = {
  fontFamily: HEADING_FONT,
  fontSize: '20px',
  fontWeight: 700,
  color: ACCENT,
  margin: '0 0 24px',
};

export const heading = {
  fontFamily: HEADING_FONT,
  fontSize: '20px',
  fontWeight: 700,
  color: '#0A0C10',
  margin: '0 0 16px',
};

export const paragraph = {
  fontFamily: BODY_FONT,
  fontSize: '15px',
  lineHeight: '24px',
  color: '#3a3a45',
  margin: '0 0 16px',
};

export const muted = {
  fontFamily: BODY_FONT,
  fontSize: '13px',
  lineHeight: '20px',
  color: '#8B92A5',
  margin: '24px 0 0',
};

export const buttonSection = {
  margin: '24px 0',
};

export const button = {
  backgroundColor: ACCENT,
  borderRadius: '8px',
  color: '#ffffff',
  fontFamily: BODY_FONT,
  fontSize: '15px',
  fontWeight: 600,
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '12px 24px',
};

export const footer = {
  fontFamily: BODY_FONT,
  fontSize: '12px',
  color: '#8B92A5',
  margin: '32px 0 0',
  borderTop: '1px solid #e5e5ec',
  paddingTop: '16px',
};
