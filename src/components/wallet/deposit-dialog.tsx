'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { depositInitiateSchema, type DepositInitiateInput } from '@/lib/validations/wallet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const CURRENCY_OPTIONS: { currency: DepositInitiateInput['currency']; provider: DepositInitiateInput['provider']; label: string }[] = [
  { currency: 'NGN', provider: 'paystack', label: 'NGN via Paystack' },
  { currency: 'USD', provider: 'stripe', label: 'USD via Stripe' },
  { currency: 'USDT', provider: 'crypto', label: 'USDT (TRC-20)' },
];

interface DepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DepositResult =
  | { provider: 'paystack'; url: string; reference: string }
  | { provider: 'stripe'; clientSecret: string; paymentIntentId: string }
  | { provider: 'crypto'; address: string; chain: string; expectedAmount: number; currency: string };

export function DepositDialog({ open, onOpenChange }: DepositDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<DepositResult | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<DepositInitiateInput>({
    resolver: zodResolver(depositInitiateSchema),
    defaultValues: { currency: 'NGN', provider: 'paystack' },
  });

  const selectedCurrency = watch('currency');

  function close(next: boolean) {
    if (!next) {
      reset({ currency: 'NGN', provider: 'paystack' });
      setResult(null);
      setServerError(null);
    }
    onOpenChange(next);
  }

  async function onSubmit(data: DepositInitiateInput) {
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
      setServerError(body?.error ?? 'Could not start deposit. Please try again.');
      return;
    }

    const body = (await res.json()) as DepositResult;

    if (body.provider === 'paystack') {
      window.location.href = body.url;
      return;
    }

    setResult(body);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deposit</DialogTitle>
          <DialogDescription>Add funds to your VaultPoint wallet.</DialogDescription>
        </DialogHeader>

        {serverError && (
          <div role="alert" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {serverError}
          </div>
        )}

        {result ? (
          <div className="space-y-4">
            {result.provider === 'crypto' && (
              <div className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm">
                <p className="text-text-secondary">
                  Send exactly <span className="font-mono-num text-text-primary">{result.expectedAmount} {result.currency}</span> ({result.chain}) to:
                </p>
                <p className="break-all rounded bg-background px-3 py-2 font-mono text-xs text-text-primary">{result.address}</p>
                <p className="text-xs text-warning">
                  Placeholder address — this feature is not yet connected to a real custodian. Do not send real funds.
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
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label>Rail</Label>
              <div className="flex flex-wrap gap-2">
                {CURRENCY_OPTIONS.map((opt) => (
                  <button
                    key={opt.currency}
                    type="button"
                    onClick={() => {
                      setValue('currency', opt.currency, { shouldValidate: true });
                      setValue('provider', opt.provider, { shouldValidate: true });
                    }}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      selectedCurrency === opt.currency
                        ? 'border-accent bg-accent/10 text-accent-light'
                        : 'border-border text-text-secondary hover:border-accent/40'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input id="amount" type="number" step="0.01" min="0" placeholder="100" {...register('amount')} />
              {errors.amount && <p className="text-xs text-warning">{errors.amount.message}</p>}
            </div>

            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              Continue
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
