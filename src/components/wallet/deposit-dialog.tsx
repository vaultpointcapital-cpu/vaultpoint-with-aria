'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import confetti from 'canvas-confetti';
import { QRCodeSVG } from 'qrcode.react';
import { depositInitiateSchema, type DepositInitiateInput } from '@/lib/validations/wallet';
import { WALLET_LIMITS } from '@/lib/wallet/limits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatMoneyJSON } from '@/lib/utils/cn';
import type { KycTierLimits } from '@/types/database';

interface RailOption {
  currency: DepositInitiateInput['currency'];
  provider: NonNullable<DepositInitiateInput['provider']>;
  label: string;
  subCopy: string;
}

const RAIL_OPTIONS: RailOption[] = [
  { currency: 'NGN', provider: 'paystack', label: 'Paystack (Bank/Card/USSD)', subCopy: 'Instant' },
  { currency: 'USD', provider: 'stripe', label: 'Card payment', subCopy: 'Card payment' },
  { currency: 'USDT', provider: 'crypto', label: 'Crypto / Web3', subCopy: 'Network fees apply' },
];

const RAIL_LABEL: Record<string, string> = {
  paystack: 'Paystack',
  stripe: 'Stripe',
  crypto: 'Crypto',
};

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onKycBlocked?: () => void;
  /** Pre-selects the rail the user last deposited with (dashboard/page.tsx
   * derives this from the most recent wallet_transactions row). */
  defaultRail?: { currency: string; provider: string };
  /** NGN-denominated monthly cap for the current KYC tier, for the "Min ·
   * Max/mo" helper line — from GET /api/kyc/status's limits. */
  kycLimits?: KycTierLimits | null;
  /** Fired once a deposit is confirmed (crypto rail's in-modal success) —
   * the dashboard wires this to router.refresh(). Paystack's redirect
   * flow never reaches this (see Step 3 below); it's picked up instead by
   * the ?deposit=success return-trip banner in dashboard-client.tsx. */
  onDeposited?: () => void;
}

type Step = 'amount' | 'confirm' | 'processing';

type DepositResult =
  | { provider: 'paystack'; url: string; reference: string }
  | { provider: 'stripe'; clientSecret: string; paymentIntentId: string }
  | { provider: 'crypto'; address: string; chain: string; isPlaceholder: boolean; expectedAmount: number; currency: string };

function railFor(currency: string, provider: string): RailOption {
  return RAIL_OPTIONS.find((r) => r.currency === currency && r.provider === provider) ?? RAIL_OPTIONS[0]!;
}

export function DepositDialog({ open, onOpenChange, onKycBlocked, defaultRail, kycLimits, onDeposited }: DepositDialogProps) {
  const [step, setStep] = useState<Step>('amount');
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<DepositResult | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [depositSuccessAmount, setDepositSuccessAmount] = useState<{ amount: number; currency: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);
  const successOriginRef = useRef<HTMLDivElement>(null);

  const initialRail = defaultRail ? railFor(defaultRail.currency, defaultRail.provider) : RAIL_OPTIONS[0]!;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isValid },
  } = useForm<DepositInitiateInput>({
    resolver: zodResolver(depositInitiateSchema),
    mode: 'onChange',
    defaultValues: { currency: initialRail.currency, provider: initialRail.provider },
  });

  const selectedCurrency = watch('currency');
  const selectedProvider = watch('provider') ?? 'paystack';
  const watchedAmount = watch('amount');

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function close(next: boolean) {
    if (!next) {
      if (pollRef.current) clearInterval(pollRef.current);
      reset({ currency: initialRail.currency, provider: initialRail.provider });
      setStep('amount');
      setResult(null);
      setServerError(null);
      setPollTimedOut(false);
      setDepositSuccessAmount(null);
    }
    onOpenChange(next);
  }

  async function onContinue() {
    setStep('confirm');
  }

  async function onConfirm(data: DepositInitiateInput) {
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/wallet/deposit/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (body?.code === 'KYC_REQUIRED' || body?.code === 'LIMIT_EXCEEDED') {
        onKycBlocked?.();
        return;
      }
      setServerError(body?.error ?? "Payment didn't go through. No funds were deducted.");
      setStep('amount');
      return;
    }

    const body = (await res.json()) as DepositResult;

    if (body.provider === 'paystack') {
      // Off-site redirect — no in-modal processing UI is meaningful here,
      // the browser leaves the page. Return trip is handled by
      // dashboard-client.tsx's ?deposit=success banner.
      window.location.href = body.url;
      return;
    }

    setResult(body);

    if (body.provider === 'crypto') {
      setStep('processing');
      startCryptoPoll(data.amount);
      return;
    }

    // Stripe: not fully wired (no Elements form) — show the existing
    // placeholder message, pre-existing gap, out of scope here.
    setStep('processing');
  }

  function startCryptoPoll(amount: number) {
    const pollStartedAt = new Date().toISOString();
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;

    pollRef.current = setInterval(async () => {
      if (Date.now() > pollDeadlineRef.current) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPollTimedOut(true);
        return;
      }

      const res = await fetch('/api/wallet/transactions?limit=5');
      if (!res.ok) return;
      const body = await res.json();
      const match = (body.transactions ?? []).find(
        (t: { type: string; provider: string; status: string; created_at: string; amount: number; currency: string }) =>
          t.type === 'deposit' && t.provider === 'web3' && t.status === 'completed' && t.created_at >= pollStartedAt
      );

      if (match) {
        if (pollRef.current) clearInterval(pollRef.current);
        setDepositSuccessAmount({ amount: match.amount, currency: match.currency });
        fireConfetti();
        onDeposited?.();
        setTimeout(() => close(false), 2000);
      }
    }, POLL_INTERVAL_MS);

    // Amount isn't known server-side until the match lands — kept as a
    // param for symmetry/future use (e.g. showing "waiting for ₦X" copy).
    void amount;
  }

  function fireConfetti() {
    const origin = successOriginRef.current?.getBoundingClientRect();
    confetti({
      particleCount: 100,
      spread: 70,
      startVelocity: 32,
      colors: ['#6C63FF', '#00E5A0', '#3B9EFF'],
      origin: origin
        ? { x: (origin.left + origin.width / 2) / window.innerWidth, y: (origin.top + origin.height / 2) / window.innerHeight }
        : { y: 0.6 },
    });
  }

  const limit = WALLET_LIMITS[selectedCurrency];
  const monthlyMax = kycLimits?.max_monthly_deposit ?? limit?.max ?? null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent mobileSheet>
        <DialogHeader>
          <DialogTitle>Deposit</DialogTitle>
          <DialogDescription>Add funds to your VaultPoint wallet.</DialogDescription>
        </DialogHeader>

        {serverError && (
          <div role="alert" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <p>{serverError}</p>
          </div>
        )}

        {step === 'amount' && (
          <form
            onSubmit={handleSubmit(onContinue)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label>Pay with</Label>
              <div className="space-y-2">
                {RAIL_OPTIONS.map((rail) => {
                  const selected = selectedCurrency === rail.currency && selectedProvider === rail.provider;
                  return (
                    <button
                      key={`${rail.currency}-${rail.provider}`}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setValue('currency', rail.currency, { shouldValidate: true });
                        setValue('provider', rail.provider, { shouldValidate: true });
                      }}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                        selected
                          ? 'border-accent bg-accent/10 text-text-primary'
                          : 'border-border text-text-secondary hover:border-accent/40'
                      }`}
                    >
                      <span className="font-medium">{rail.label}</span>
                      <span className="text-xs text-text-tertiary">{rail.subCopy}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0"
                className="font-mono-num text-xl"
                placeholder="0.00"
                {...register('amount')}
              />
              {errors.amount ? (
                <p className="text-xs text-warning">{errors.amount.message}</p>
              ) : (
                limit && (
                  <p className="text-xs text-text-tertiary">
                    Min {formatMoneyJSON({ amount: String(limit.min), currency: selectedCurrency })}
                    {monthlyMax !== null && (
                      <> · Max {formatMoneyJSON({ amount: String(monthlyMax), currency: selectedCurrency })}/mo</>
                    )}
                  </p>
                )
              )}
            </div>

            <Button type="submit" className="w-full" disabled={!isValid || !watchedAmount}>
              Continue
            </Button>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface-elevated p-4 text-sm">
              <p className="text-text-primary">
                Depositing {formatMoneyJSON({ amount: String(watchedAmount), currency: selectedCurrency })} via{' '}
                {RAIL_LABEL[selectedProvider]}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {selectedProvider === 'paystack' && "You'll be redirected to complete payment."}
                {selectedProvider === 'crypto' && "You'll receive a deposit address."}
                {selectedProvider === 'stripe' && 'Card payment via Stripe.'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStep('amount')}>
                Back
              </Button>
              <Button className="flex-1" isLoading={isSubmitting} onClick={handleSubmit(onConfirm)}>
                Confirm &amp; Continue
              </Button>
            </div>
          </div>
        )}

        {step === 'processing' && result && (
          <div ref={successOriginRef} className="space-y-4">
            {result.provider === 'crypto' && !depositSuccessAmount && !pollTimedOut && (
              <div className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm">
                <p className="text-text-secondary">
                  Send exactly{' '}
                  <span className="font-mono-num text-text-primary">
                    {result.expectedAmount} {result.currency}
                  </span>{' '}
                  ({result.chain}) to:
                </p>
                <div className="flex justify-center rounded bg-background p-3">
                  <QRCodeSVG value={result.address} size={160} marginSize={2} />
                </div>
                <p className="break-all rounded bg-background px-3 py-2 font-mono text-xs text-text-primary">{result.address}</p>
                {result.isPlaceholder && (
                  <p className="text-xs text-warning">
                    Placeholder address — this feature is not yet connected to a real custodian. Do not send real funds.
                  </p>
                )}
                <div className="flex items-center gap-2 pt-1 text-xs text-text-tertiary">
                  <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-info" />
                  Waiting for your deposit…
                </div>
              </div>
            )}

            {result.provider === 'crypto' && pollTimedOut && !depositSuccessAmount && (
              <p className="text-sm text-text-secondary">Still processing, we&apos;ll notify you.</p>
            )}

            {result.provider === 'crypto' && depositSuccessAmount && (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <SuccessCheck />
                <p className="text-sm text-text-primary">
                  {formatMoneyJSON({ amount: String(depositSuccessAmount.amount), currency: depositSuccessAmount.currency })} added
                  to your wallet
                </p>
              </div>
            )}

            {result.provider === 'stripe' && (
              <div className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm text-text-secondary">
                <p>
                  A Stripe PaymentIntent was created (<span className="font-mono text-xs">{result.paymentIntentId}</span>), but
                  completing card payment in-app requires the Stripe Elements card form, which isn&apos;t wired up yet.
                </p>
              </div>
            )}

            <Button className="w-full" onClick={() => close(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Animated checkmark — same stroke-dashoffset transition technique as
 * src/components/pods/pod-arc.tsx (mount-then-animate, ~800ms ease-out),
 * reused here for motion-language consistency per the component spec. */
function SuccessCheck() {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg width={56} height={56} viewBox="0 0 56 56" aria-hidden>
      <circle cx={28} cy={28} r={26} fill="none" stroke="currentColor" strokeWidth={2} className="text-success/30" />
      <path
        d="M17 29 L24 36 L39 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-success"
        style={{
          strokeDasharray: 34,
          strokeDashoffset: drawn ? 0 : 34,
          transition: 'stroke-dashoffset 800ms ease-out',
        }}
      />
    </svg>
  );
}
