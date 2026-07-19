'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DISCLOSURE_DOCUMENT_VERSION,
  AUTHORIZATION_DOCUMENT_VERSION,
  MANAGED_TIER_TERMS,
} from '@/lib/validations/managed-accounts';
import type { ManagedTier, SubscriptionTier } from '@/types/database';

const TIERS: ManagedTier[] = ['bronze', 'silver', 'gold'];

// Placeholder document — this is NOT the real, legally-approved risk
// disclosure. Real content (audited historical performance, exact
// fee/split language, jurisdiction-specific risk-of-loss statement)
// must come from Legal before this flow accepts real clients. Flagged
// here rather than silently shipping placeholder copy as if it were
// final.
export const DISCLOSURE_TEXT = `RISK OF LOSS

Trading foreign exchange, contracts for difference, and cryptocurrency derivatives on margin carries a high level of risk and may not be suitable for all investors. You could sustain a loss of some or all of your initial capital and should not invest money that you cannot afford to lose.

VaultPoint Managed Accounts does not guarantee any specific rate of return. Past performance, including any historical performance figures VaultPoint may present, is not indicative of future results.

DRAWDOWN POLICY

Each Managed Tier has a stated maximum drawdown policy. VaultPoint's trading discretion is bound by this policy, but a drawdown approaching or reaching the stated maximum can and does happen. You will be notified as your account approaches this threshold.

FEE / SPLIT STRUCTURE

VaultPoint retains a percentage of realized profit ("the split") as compensation for managing your account, per your selected tier. VaultPoint does not charge a fee on losses, and does not charge against your principal.

CUSTODY

Your capital is held in a segregated sub-account at VaultPoint's broker/custodian, in your name — never in a VaultPoint-held account. VaultPoint's authority to trade this account is limited to the scope of the authorization you sign in the next step, and can be revoked by you at any time.`;

type Step = 'disclosure' | 'kyc' | 'authorization' | 'provision' | 'funding' | 'done';

interface OnboardingWizardProps {
  subscriptionTier: SubscriptionTier;
}

export function OnboardingWizard({ subscriptionTier: _subscriptionTier }: OnboardingWizardProps) {
  const router = useRouter();
  const [tier, setTier] = useState<ManagedTier>('bronze');
  const [step, setStep] = useState<Step>('disclosure');
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [disclosureViewId, setDisclosureViewId] = useState<string | null>(null);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const disclosureRef = useRef<HTMLDivElement>(null);

  const [typedLegalName, setTypedLegalName] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

  const [managedAccountId, setManagedAccountId] = useState<string | null>(null);
  const [mtLogin, setMtLogin] = useState('');
  const [mtServer, setMtServer] = useState('');
  const [mtPlatform, setMtPlatform] = useState<'mt4' | 'mt5'>('mt5');
  const [mtPassword, setMtPassword] = useState('');

  const [startingCapital, setStartingCapital] = useState('');

  // Step 2 acceptance criteria: view is logged with a timestamp as soon
  // as the disclosure screen opens, independent of whether the client
  // ever finishes reading it.
  useEffect(() => {
    fetch('/api/managed-accounts/disclosure-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentVersion: DISCLOSURE_DOCUMENT_VERSION }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.disclosureView?.id) setDisclosureViewId(body.disclosureView.id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDisclosureScroll() {
    const el = disclosureRef.current;
    if (!el || hasScrolledToBottom) return;
    const reachedBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (reachedBottom) {
      setHasScrolledToBottom(true);
      if (disclosureViewId) {
        fetch(`/api/managed-accounts/disclosure-view/${disclosureViewId}`, { method: 'PATCH' });
      }
    }
  }

  async function handleAuthorizationSubmit() {
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/managed-accounts/authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentVersion: AUTHORIZATION_DOCUMENT_VERSION,
        documentUrl: `${window.location.origin}/legal/managed-accounts-authorization-v1`,
        typedLegalName,
        consent: consentChecked,
      }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not record your authorization. Please try again.');
      return;
    }

    setStep('provision');
  }

  async function handleProvisionSubmit() {
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/managed-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, mtLogin, mtServer, mtPlatform, mtPassword }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not create your managed account. Please try again.');
      return;
    }

    const { managedAccount } = await res.json();
    setManagedAccountId(managedAccount.id);
    setStep('kyc');
  }

  async function handleFundingSubmit() {
    if (!managedAccountId) return;
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/managed-accounts/${managedAccountId}/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startingCapital: Number(startingCapital) }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not confirm funding. Please try again.');
      return;
    }

    setStep('done');
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">
          Open a Managed Account
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          This is a formal authorization process, not a subscription upgrade — read each step
          carefully.
        </p>
      </div>

      {serverError && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {serverError}
        </div>
      )}

      {step === 'disclosure' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <div className="space-y-2">
            <Label htmlFor="tier">Managed Tier</Label>
            <select
              id="tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as ManagedTier)}
              className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)} — {MANAGED_TIER_TERMS[t].profitSplitPct}% profit split,
                  max {MANAGED_TIER_TERMS[t].maxDrawdownPct}% drawdown
                </option>
              ))}
            </select>
          </div>

          <h2 className="font-display text-base font-semibold text-text-primary">Risk Disclosure</h2>
          <div
            ref={disclosureRef}
            onScroll={handleDisclosureScroll}
            className="h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-xs leading-relaxed text-text-secondary"
          >
            {DISCLOSURE_TEXT}
          </div>
          <p className="text-xs text-text-tertiary">
            {hasScrolledToBottom
              ? 'You have read this disclosure in full.'
              : 'Scroll to the bottom to continue.'}
          </p>
          <Button onClick={() => setStep('authorization')} disabled={!hasScrolledToBottom} className="w-full">
            Continue
          </Button>
        </div>
      )}

      {step === 'authorization' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">
            Trading Authorization (Limited Power of Attorney)
          </h2>
          <p className="text-sm text-text-secondary">
            By signing below, you grant VaultPoint limited authority to place trades on your
            segregated Managed Account sub-account, bound by the {tier} tier&apos;s stated risk
            and split policy. This authorization can be revoked by you at any time.
          </p>

          <div className="space-y-2">
            <Label htmlFor="typedLegalName">Type your full legal name to sign</Label>
            <Input
              id="typedLegalName"
              value={typedLegalName}
              onChange={(e) => setTypedLegalName(e.target.value)}
              placeholder="Jane A. Doe"
            />
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-elevated p-3">
            <input
              id="authConsent"
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
            />
            <Label htmlFor="authConsent" className="text-xs font-normal leading-relaxed text-text-secondary">
              I have read and understood the risk disclosure, and I authorize VaultPoint to trade
              my Managed Account sub-account under the terms above.
            </Label>
          </div>

          <Button
            onClick={handleAuthorizationSubmit}
            disabled={!consentChecked || typedLegalName.trim().length < 2}
            isLoading={isSubmitting}
            className="w-full"
          >
            Sign authorization
          </Button>
        </div>
      )}

      {step === 'provision' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">
            Sub-Account Provisioning
          </h2>
          <p className="text-sm text-text-secondary">
            Provide MetaTrader account details for the sub-account VaultPoint will trade on your
            behalf. Only MetaTrader is supported for Managed Accounts today.
          </p>

          <div className="space-y-2">
            <Label htmlFor="mtLogin">MT account login</Label>
            <Input id="mtLogin" value={mtLogin} onChange={(e) => setMtLogin(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mtServer">MT server</Label>
            <Input
              id="mtServer"
              placeholder="Exness-MT5Real8"
              value={mtServer}
              onChange={(e) => setMtServer(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mtPlatform">Platform</Label>
            <select
              id="mtPlatform"
              value={mtPlatform}
              onChange={(e) => setMtPlatform(e.target.value as 'mt4' | 'mt5')}
              className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              <option value="mt4">MT4</option>
              <option value="mt5">MT5</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mtPassword">MT trading password</Label>
            <Input id="mtPassword" type="password" value={mtPassword} onChange={(e) => setMtPassword(e.target.value)} />
          </div>

          <Button
            onClick={handleProvisionSubmit}
            disabled={!mtLogin || !mtServer || !mtPassword}
            isLoading={isSubmitting}
            className="w-full"
          >
            Create sub-account
          </Button>
        </div>
      )}

      {step === 'kyc' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6 text-center">
          <h2 className="font-display text-base font-semibold text-text-primary">
            Identity Verification In Progress
          </h2>
          <p className="text-sm text-text-secondary">
            Your Managed Account has been created and is pending identity verification. This is a
            manual review step — you&apos;ll be notified once it&apos;s complete, and you can then
            fund your account.
          </p>
          <Button variant="outline" onClick={() => setStep('funding')}>
            I&apos;ve been notified my KYC is verified — continue to funding
          </Button>
        </div>
      )}

      {step === 'funding' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">Fund Your Account</h2>
          <p className="text-sm text-text-secondary">
            Deposit capital directly into your segregated sub-account using your existing payment
            method on the broker&apos;s platform, then confirm the amount below.
          </p>

          <div className="space-y-2">
            <Label htmlFor="startingCapital">Starting capital deposited (USD)</Label>
            <Input
              id="startingCapital"
              type="number"
              min="0"
              step="0.01"
              value={startingCapital}
              onChange={(e) => setStartingCapital(e.target.value)}
            />
          </div>

          <Button
            onClick={handleFundingSubmit}
            disabled={!startingCapital || Number(startingCapital) <= 0}
            isLoading={isSubmitting}
            className="w-full"
          >
            Confirm funding
          </Button>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6 text-center">
          <h2 className="font-display text-base font-semibold text-text-primary">Account Active</h2>
          <p className="text-sm text-text-secondary">
            Your Managed Account is now active. Your first statement will be issued at your next
            reporting date.
          </p>
          <Button onClick={() => router.push('/dashboard/managed-accounts')}>
            Go to your Managed Account
          </Button>
        </div>
      )}
    </div>
  );
}
