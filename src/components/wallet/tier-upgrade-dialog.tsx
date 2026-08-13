'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { tier1VerifySchema, tier2VerifySchema, type Tier1VerifyInput, type Tier2VerifyInput } from '@/lib/validations/kyc-tier';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { KycTier } from '@/types/database';

interface TierUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTier: KycTier;
  onTierChanged: (tier: KycTier) => void;
}

export function TierUpgradeDialog({ open, onOpenChange, currentTier, onTierChanged }: TierUpgradeDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const tier1Form = useForm<Tier1VerifyInput>({
    resolver: zodResolver(tier1VerifySchema),
    defaultValues: { phone: '', email: '', idType: 'national_id', idNumber: '' },
  });

  const tier2Form = useForm<Tier2VerifyInput>({
    resolver: zodResolver(tier2VerifySchema),
    defaultValues: { bvnOrNin: '', livenessSelfieRef: '' },
  });

  function close(next: boolean) {
    if (!next) {
      tier1Form.reset();
      tier2Form.reset();
      setServerError(null);
    }
    onOpenChange(next);
  }

  async function onSubmitTier1(data: Tier1VerifyInput) {
    setServerError(null);
    setIsSubmitting(true);
    const res = await fetch('/api/kyc/verify/tier1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    setIsSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not complete Tier 1 verification. Please try again.');
      return;
    }
    const body = await res.json();
    onTierChanged(body.tier);
  }

  async function onSubmitTier2(data: Tier2VerifyInput) {
    setServerError(null);
    setIsSubmitting(true);
    const res = await fetch('/api/kyc/verify/tier2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    setIsSubmitting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not complete Tier 2 verification. Please try again.');
      return;
    }
    const body = await res.json();
    onTierChanged(body.tier);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify your identity</DialogTitle>
          <DialogDescription>
            {currentTier === 'tier0' && 'Tier 1 unlocks deposits — instant, no manual review.'}
            {currentTier === 'tier1' && 'Tier 2 unlocks withdrawals and removes deposit limits.'}
            {currentTier === 'tier2' && 'You are fully verified.'}
          </DialogDescription>
        </DialogHeader>

        {serverError && (
          <div role="alert" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {serverError}
          </div>
        )}

        {currentTier === 'tier0' && (
          <form onSubmit={tier1Form.handleSubmit(onSubmitTier1)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone number</Label>
              <Input id="phone" {...tier1Form.register('phone')} />
              {tier1Form.formState.errors.phone && (
                <p className="text-xs text-warning">{tier1Form.formState.errors.phone.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...tier1Form.register('email')} />
              {tier1Form.formState.errors.email && (
                <p className="text-xs text-warning">{tier1Form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="idType">ID type</Label>
              <select
                id="idType"
                {...tier1Form.register('idType')}
                className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary"
              >
                <option value="national_id">National ID</option>
                <option value="drivers_license">Driver&apos;s license</option>
                <option value="passport">Passport</option>
                <option value="voters_card">Voter&apos;s card</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="idNumber">ID number</Label>
              <Input id="idNumber" {...tier1Form.register('idNumber')} />
              {tier1Form.formState.errors.idNumber && (
                <p className="text-xs text-warning">{tier1Form.formState.errors.idNumber.message}</p>
              )}
            </div>
            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              Verify Tier 1
            </Button>
          </form>
        )}

        {currentTier === 'tier1' && (
          <form onSubmit={tier2Form.handleSubmit(onSubmitTier2)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bvnOrNin">BVN or NIN</Label>
              <Input id="bvnOrNin" inputMode="numeric" {...tier2Form.register('bvnOrNin')} />
              {tier2Form.formState.errors.bvnOrNin && (
                <p className="text-xs text-warning">{tier2Form.formState.errors.bvnOrNin.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="livenessSelfieRef">Liveness capture</Label>
              <Input id="livenessSelfieRef" placeholder="Capture reference" {...tier2Form.register('livenessSelfieRef')} />
              {tier2Form.formState.errors.livenessSelfieRef && (
                <p className="text-xs text-warning">{tier2Form.formState.errors.livenessSelfieRef.message}</p>
              )}
              <p className="text-xs text-text-tertiary">
                Real selfie capture isn&apos;t wired up yet — this is a placeholder reference field.
              </p>
            </div>
            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              Verify Tier 2
            </Button>
          </form>
        )}

        {currentTier === 'tier2' && (
          <Button className="w-full" onClick={() => close(false)}>
            Done
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
