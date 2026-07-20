import type { Metadata } from 'next';
import { LegalPageLayout } from '@/components/legal/legal-page-layout';

export const metadata: Metadata = { title: 'Risk Disclosure — VaultPoint' };

export default function RiskDisclosurePage() {
  return (
    <LegalPageLayout title="Risk Disclosure" lastUpdated="July 2026">
      <section>
        <h2>1. Market risk</h2>
        <p>
          Trading foreign exchange, crypto assets, and derivatives on margin carries a high level of risk and may
          not be suitable for all investors. You could sustain a loss of some or all of your capital. Never trade
          or invest money you cannot afford to lose. Past performance — including any win-rate or track record
          statistics VaultPoint displays — is not indicative of future results.
        </p>
      </section>

      <section>
        <h2>2. Data delay and accuracy limits</h2>
        <p>
          Portfolio and position data syncs from your connected broker on a polling cycle (currently about once
          per minute) — figures shown in the app can lag the real, live state of your account by that interval,
          more during a broker outage (VaultPoint keeps showing your last known data rather than clearing it, and
          marks the connection as degraded). Never treat a displayed figure as a real-time execution price.
        </p>
      </section>

      <section>
        <h2>3. Automated execution risk (Signal Mode &amp; Managed Mode)</h2>
        <p>
          Signal Mode trades only execute when you personally tap Execute on a specific signal. Managed Mode
          trades execute automatically, without a per-trade tap, within risk limits you configure — you are
          responsible for setting limits appropriate to your own risk tolerance. Both modes execute real orders on
          your own connected broker account; VaultPoint is not liable for broker-side slippage, rejected orders,
          or losses resulting from market conditions.
        </p>
      </section>

      <section>
        <h2>4. Custody — what VaultPoint does and does not hold</h2>
        <p>
          For portfolio tracking, Signal Mode, and Managed Mode, VaultPoint never takes custody of your funds —
          your capital stays on your own broker account, which you can disconnect at any time. Managed Accounts is
          the one exception: VaultPoint holds client capital in a segregated custodial sub-account under a signed,
          revocable limited power of attorney, subject to identity verification. If you have not explicitly
          completed Managed Accounts onboarding, this does not apply to you.
        </p>
      </section>

      <section>
        <h2>5. No guaranteed returns</h2>
        <p>
          VaultPoint does not promise or guarantee any specific return, win rate, or outcome, in any product tier
          or mode.
        </p>
      </section>

      <section>
        <h2>6. Not financial advice</h2>
        <p>
          Nothing in VaultPoint, including anything Aria (VaultPoint&apos;s AI assistant) says, constitutes
          personalized financial, investment, or trading advice. Aria is not a licensed financial advisor.
        </p>
      </section>
    </LegalPageLayout>
  );
}
