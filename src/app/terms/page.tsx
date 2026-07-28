import type { Metadata } from 'next';
import { LegalPageLayout } from '@/components/legal/legal-page-layout';

export const metadata: Metadata = { title: 'Terms of Service — VaultPoint' };

/**
 * DEVIATION FROM THE ORIGINAL BRIEF, FLAGGED DELIBERATELY: the brief
 * asked this page to state VaultPoint "holds no funds, executes no
 * trades." Neither is true of the product as actually built:
 * - Signal Mode executes real trades on a user's own connected broker
 *   account when they tap Execute (services/broker-sync/app/signal_execution.py).
 * - Managed Mode executes real trades autonomously on a user's own
 *   connected broker account, under explicit opt-in consent and risk
 *   limits, with no per-trade tap (services/broker-sync/app/managed_mode.py).
 * - Managed Accounts holds client capital in a segregated custodial
 *   sub-account under a signed limited power of attorney, subject to
 *   KYC (supabase/migrations/20260718000004_add_managed_accounts.sql).
 * Publishing the brief's original claim would be a materially false
 * statement in a real legal document about whether the platform trades
 * or holds funds — worse than not having this page at all. Written to
 * accurately describe what each mode actually does instead, with the
 * scope differences stated explicitly. This needs real legal review
 * before launch regardless — flagged here so that review starts from
 * accurate text, not the original (incorrect) premise.
 *
 * Refund policy is written as the brief specified (7-day refund on
 * first charge, none on renewals) — but no refund is actually automated
 * anywhere in this codebase (grepped the whole app; found nothing).
 * This states a genuine commitment, not a description of working
 * software — a refund request today would need a human to process it
 * manually via the Stripe/Paystack dashboard.
 */
export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service" lastUpdated="July 2026">
      <section>
        <h2>1. What VaultPoint is</h2>
        <p>
          VaultPoint is a portfolio tracking, market signal, and (for eligible clients) managed-trading platform.
          It is an informational and execution tool — not a licensed financial advisor, and nothing in the app
          constitutes personalized investment advice. You are responsible for your own trading and investment
          decisions.
        </p>
      </section>

      <section>
        <h2>2. The three ways VaultPoint can touch your money — read this carefully</h2>
        <p>VaultPoint offers materially different products with different levels of access to your funds:</p>
        <ul>
          <li>
            <strong>Portfolio tracking (all users):</strong> read-only. VaultPoint never places a trade, never
            moves funds, and never has withdrawal access on a tracking-only connection.
          </li>
          <li>
            <strong>Signal Mode (opt-in):</strong> VaultPoint&apos;s AI (&quot;Aria&quot;) proposes trade ideas.
            Nothing executes unless you personally tap &quot;Execute&quot; on that specific trade, on your own
            connected broker account. You explicitly re-authorize a connection with trade-permission credentials
            before this is possible — a read-only connection can never trade.
          </li>
          <li>
            <strong>Managed Mode (opt-in, Elite tier):</strong> Aria places trades automatically on your own
            connected broker account, without a per-trade tap, within risk limits you set (capped per-trade risk
            and a daily-loss kill switch) and only after explicit consent. VaultPoint never takes custody of your
            funds in this mode — trades execute on the broker account you control and can disconnect at any time.
          </li>
          <li>
            <strong>Managed Accounts (opt-in, separate onboarding):</strong> VaultPoint holds and discretionarily
            trades your capital in a segregated custodial sub-account, under a limited power of attorney you sign
            and can revoke, subject to identity verification (KYC). This is the one VaultPoint product where
            VaultPoint takes custody. It has its own disclosure and authorization flow, separate from the rest of
            this app.
          </li>
        </ul>
        <p>Which of these apply to you depends entirely on what you&apos;ve explicitly opted into.</p>
      </section>

      <section>
        <h2>3. No guaranteed returns</h2>
        <p>
          VaultPoint does not guarantee any rate of return, and past performance (including any track record
          statistics shown in the app) is not indicative of future results. Trading and investing carry real risk
          of loss, including loss of principal. See the Risk Disclosure for more detail.
        </p>
      </section>

      <section>
        <h2>4. Subscriptions and billing</h2>
        <p>
          Paid tiers renew automatically until cancelled. Managed Mode carries an additional profit-share fee on
          realized profit Aria attributes to autonomous trades only — never on trades you place yourself, and
          never on a loss.
        </p>
      </section>

      <section>
        <h2>5. Refunds</h2>
        <p>
          First-time subscription charges are eligible for a refund if requested within 7 days of that charge.
          Renewal charges are not refundable. Contact support@vaultpoint.name.ng to request one.
        </p>
      </section>

      <section>
        <h2>6. Account termination</h2>
        <p>
          You may close your account at any time. VaultPoint may suspend or terminate access for violation of
          these terms, suspected fraud, or as required by law.
        </p>
      </section>

      <section>
        <h2>7. Limitation of liability</h2>
        <p>
          VaultPoint is provided &quot;as is.&quot; To the maximum extent permitted by law, VaultPoint is not
          liable for trading losses, missed trades due to service interruption, or decisions made based on
          information the app displays.
        </p>
      </section>

      <section>
        <h2>8. Contact</h2>
        <p>Questions about these terms: support@vaultpoint.name.ng</p>
      </section>
    </LegalPageLayout>
  );
}
