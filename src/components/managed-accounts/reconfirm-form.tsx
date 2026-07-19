'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DISCLOSURE_TEXT } from '@/components/managed-accounts/onboarding-wizard';
import { DISCLOSURE_DOCUMENT_VERSION, AUTHORIZATION_DOCUMENT_VERSION } from '@/lib/validations/managed-accounts';

type Step = 'disclosure' | 'authorization' | 'done';

interface ReconfirmFormProps {
  accountId: string;
}

/**
 * The client-facing half of terms reconfirmation — a re-read of the
 * current disclosure and a fresh signature, same acceptance criteria as
 * onboarding's own disclosure/authorization steps (see
 * onboarding-wizard.tsx), just without the KYC/provisioning/funding
 * steps an already-active account doesn't need again. Submits to
 * POST /api/managed-accounts/:id/reconfirm last, which re-verifies both
 * records exist server-side before clearing
 * requires_disclosure_reconfirmation.
 */
export function ReconfirmForm({ accountId }: ReconfirmFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('disclosure');
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [disclosureViewId, setDisclosureViewId] = useState<string | null>(null);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const disclosureRef = useRef<HTMLDivElement>(null);

  const [typedLegalName, setTypedLegalName] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

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

    const authRes = await fetch('/api/managed-accounts/authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentVersion: AUTHORIZATION_DOCUMENT_VERSION,
        documentUrl: `${window.location.origin}/legal/managed-accounts-authorization-v1`,
        typedLegalName,
        consent: consentChecked,
      }),
    });

    if (!authRes.ok) {
      setIsSubmitting(false);
      const body = await authRes.json().catch(() => null);
      setServerError(body?.error ?? 'Could not record your authorization. Please try again.');
      return;
    }

    const reconfirmRes = await fetch(`/api/managed-accounts/${accountId}/reconfirm`, { method: 'POST' });
    setIsSubmitting(false);

    if (!reconfirmRes.ok) {
      const body = await reconfirmRes.json().catch(() => null);
      setServerError(body?.error ?? 'Could not confirm updated terms. Please try again.');
      return;
    }

    setStep('done');
    router.refresh();
  }

  if (step === 'done') {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6 text-center">
        <h1 className="font-display text-xl font-semibold text-text-primary">Terms reconfirmed</h1>
        <p className="text-sm text-text-secondary">Your account is back to normal standing.</p>
        <Button onClick={() => router.push(`/dashboard/managed-accounts/${accountId}`)}>Back to account</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Reconfirm updated terms</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Your Managed Tier&apos;s terms have changed. Re-read the disclosure and re-sign the authorization to
          continue.
        </p>
      </div>

      {serverError && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {serverError}
        </div>
      )}

      {step === 'disclosure' && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">Risk Disclosure</h2>
          <div
            ref={disclosureRef}
            onScroll={handleDisclosureScroll}
            className="h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-xs leading-relaxed text-text-secondary"
          >
            {DISCLOSURE_TEXT}
          </div>
          <p className="text-xs text-text-tertiary">
            {hasScrolledToBottom ? 'You have read this disclosure in full.' : 'Scroll to the bottom to continue.'}
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
              I have read and understood the updated risk disclosure, and I re-authorize VaultPoint to trade my
              Managed Account sub-account under the updated terms.
            </Label>
          </div>

          <Button
            onClick={handleAuthorizationSubmit}
            disabled={!consentChecked || typedLegalName.trim().length < 2}
            isLoading={isSubmitting}
            className="w-full"
          >
            Sign &amp; reconfirm
          </Button>
        </div>
      )}
    </div>
  );
}
