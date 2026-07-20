import type { Metadata } from 'next';
import { LegalPageLayout } from '@/components/legal/legal-page-layout';

export const metadata: Metadata = { title: 'Privacy Policy — VaultPoint' };

const SUB_PROCESSORS = [
  { name: 'Vercel', purpose: 'Application hosting and edge network' },
  { name: 'Supabase', purpose: 'Database, authentication, and file storage' },
  { name: 'Railway', purpose: 'Broker-sync background service hosting' },
  { name: 'Upstash', purpose: 'Rate limiting and caching (Redis)' },
  { name: 'Paystack', purpose: 'Payment processing (NGN)' },
  { name: 'Stripe', purpose: 'Payment processing (USD)' },
  { name: 'Resend', purpose: 'Transactional email delivery' },
  { name: 'Sentry', purpose: 'Error monitoring' },
  { name: 'Anthropic', purpose: "Aria's AI model (Claude)" },
];

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" lastUpdated="July 2026">
      <section>
        <h2>1. What we collect</h2>
        <ul>
          <li>Account information: name, email, country.</li>
          <li>
            Broker connection data: encrypted API credentials (AES-256-GCM, never stored or logged in plaintext),
            and the positions/balances those credentials give read access to.
          </li>
          <li>Usage data: signals viewed and acted on, alerts configured, pages visited.</li>
          <li>
            For Managed Accounts only: identity verification (KYC) documents and a signed trading authorization.
          </li>
          <li>Payment data: handled entirely by Stripe/Paystack — VaultPoint never stores card numbers.</li>
        </ul>
      </section>

      <section>
        <h2>2. How we use it</h2>
        <p>
          To operate the service (sync your portfolio, execute trades you authorize, calculate billing), to
          communicate with you (account, security, and billing emails), and to improve the product. We do not
          sell your personal data.
        </p>
      </section>

      <section>
        <h2>3. Sub-processors</h2>
        <p>Third-party services that process data on VaultPoint&apos;s behalf:</p>
        <ul>
          {SUB_PROCESSORS.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong> — {p.purpose}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>4. Data security</h2>
        <p>
          Broker API credentials and Managed Account credentials are encrypted at rest (AES-256-GCM, per-field
          initialization vectors) and are never written to application logs. Access to production data is
          restricted to service-role backend processes; row-level security in the database restricts every user
          to their own data.
        </p>
      </section>

      <section>
        <h2>5. Data retention</h2>
        <p>
          Account and trading history is retained for as long as your account is active, plus a period after
          closure as required for financial record-keeping and dispute resolution.
        </p>
      </section>

      <section>
        <h2>6. Your rights</h2>
        <p>
          You can request a copy of your data or request deletion of your account by contacting
          support@vaultpoint.name.ng. Some records (e.g. signed authorizations, billing history) may be retained
          as required by law even after account closure.
        </p>
      </section>

      <section>
        <h2>7. Contact</h2>
        <p>Privacy questions: support@vaultpoint.name.ng</p>
      </section>
    </LegalPageLayout>
  );
}
