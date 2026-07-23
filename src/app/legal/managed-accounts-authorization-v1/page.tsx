import type { Metadata } from 'next';
import { LegalPageLayout } from '@/components/legal/legal-page-layout';

export const metadata: Metadata = { title: 'Managed Account Trading Authorization — VaultPoint' };

// Placeholder document — same status as onboarding-wizard.tsx's own
// DISCLOSURE_TEXT: not the real, legally-approved limited power of
// attorney. Real content (jurisdiction-specific PoA language, exact
// scope-of-authority terms) must come from Legal before this flow
// accepts real clients. Created because client_authorizations.document_url
// (see the onboarding wizard's authorization step) previously pointed at
// this exact path with nothing here — a signed authorization record
// referencing a 404 is worse than one referencing clearly-marked
// placeholder text, so this exists now rather than staying a dead link.
export default function ManagedAccountsAuthorizationPage() {
  return (
    <LegalPageLayout title="Managed Account Trading Authorization (v1)" lastUpdated="July 2026">
      <section>
        <h2>1. Grant of limited authority</h2>
        <p>
          By signing this authorization, you (&quot;the Client&quot;) grant VaultPoint a limited power of attorney
          to place, manage, and close trades on your behalf within a segregated Managed Account sub-account held in
          your name. This authority is limited strictly to trading activity within the risk parameters of your
          selected Managed Tier — it does not authorize VaultPoint to withdraw funds, transfer funds to any account
          other than your own, change your account&apos;s ownership, or take any action outside placing and
          managing trades.
        </p>
      </section>

      <section>
        <h2>2. Scope bound by tier policy</h2>
        <p>
          VaultPoint&apos;s trading discretion under this authorization is bound by the maximum drawdown policy and
          risk parameters stated for your selected Managed Tier at the time of signing. VaultPoint may not exceed
          these bounds under this authorization. If VaultPoint&apos;s tier terms change after you sign, you must
          re-accept the updated terms before they apply to your account — this is enforced automatically the next
          time you open your Managed Account dashboard.
        </p>
      </section>

      <section>
        <h2>3. Custody</h2>
        <p>
          Your capital is held in a segregated sub-account at VaultPoint&apos;s broker/custodian, in your name —
          never in an account VaultPoint itself holds title to. This authorization governs trading discretion only;
          it does not transfer ownership or custody of your capital to VaultPoint.
        </p>
      </section>

      <section>
        <h2>4. Revocation</h2>
        <p>
          You may revoke this authorization at any time from your Managed Account dashboard. Revocation takes
          effect immediately for any new trade; VaultPoint will close or hand back discretion over any open
          position according to the process described in your Managed Account dashboard at the time of revocation.
          Revoking this authorization does not, by itself, close your Managed Account or withdraw your funds — see
          the separate withdrawal flow for that.
        </p>
      </section>

      <section>
        <h2>5. Compensation</h2>
        <p>
          VaultPoint is compensated for trading under this authorization solely through the profit split stated for
          your Managed Tier, deducted only from realized profit. VaultPoint does not charge a fee on losses and
          does not charge against your principal.
        </p>
      </section>

      <section>
        <h2>6. Signature</h2>
        <p>
          Your typed legal name, the timestamp, and the document version you signed are recorded as your signature
          on this authorization, per the record shown in your Managed Account onboarding confirmation.
        </p>
      </section>
    </LegalPageLayout>
  );
}
