'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withdrawRequestSchema, type WithdrawRequestInput } from '@/lib/validations/wallet';
import { WITHDRAWAL_REVIEW_HOLD_THRESHOLD_NGN } from '@/lib/wallet/limits';
import { isValidCryptoAddress } from '@/lib/validations/crypto-address';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatMoneyJSON } from '@/lib/utils/cn';
import type { Wallet } from '@/types/database';

const DESTINATION_TYPE_BY_CURRENCY: Record<string, WithdrawRequestInput['destinationType']> = {
  NGN: 'bank_account',
  USD: 'bank_account',
  USDT: 'crypto_address',
};

interface WithdrawDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wallets: Pick<Wallet, 'currency' | 'balance_cached' | 'updated_at'>[];
  onWithdrawn: () => void;
  onKycBlocked?: () => void;
}

type StepUpMethod = 'push' | 'totp' | 'telegram';
type Stage = 'form' | 'confirm' | 'step-up' | 'done';

export function WithdrawDialog({ open, onOpenChange, wallets, onWithdrawn, onKycBlocked }: WithdrawDialogProps) {
  const [stage, setStage] = useState<Stage>('form');
  const [serverError, setServerError] = useState<string | null>(null);
  const [kycBlocked, setKycBlocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [withdrawalRequestId, setWithdrawalRequestId] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [methods, setMethods] = useState<StepUpMethod[]>([]);
  const [totpCode, setTotpCode] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<WithdrawRequestInput>({
    resolver: zodResolver(withdrawRequestSchema),
    mode: 'onChange',
    defaultValues: { currency: 'NGN', destinationType: 'bank_account', destinationDetails: {} },
  });

  const currency = watch('currency');
  const watchedAmount = watch('amount');
  const watchedAddress = watch('destinationDetails.address');
  const destinationType = DESTINATION_TYPE_BY_CURRENCY[currency] ?? 'bank_account';
  const selectedWallet = wallets.find((w) => w.currency === currency);
  const showReviewHold = currency === 'NGN' && Number(watchedAmount) > WITHDRAWAL_REVIEW_HOLD_THRESHOLD_NGN;

  // Client-side-only feedback — spec 4.3.2's actual enforcement gate is
  // server-side, in POST /api/wallet/withdraw/confirm, using the exact
  // same isValidCryptoAddress helper. This is just so a malformed
  // address doesn't cost the user a round trip to find out.
  const [addressValidity, setAddressValidity] = useState<'unchecked' | 'valid' | 'invalid'>('unchecked');
  useEffect(() => {
    if (destinationType !== 'crypto_address' || !watchedAddress) {
      setAddressValidity('unchecked');
      return;
    }
    let cancelled = false;
    isValidCryptoAddress('TRC20', watchedAddress).then((valid) => {
      if (!cancelled) setAddressValidity(valid ? 'valid' : 'invalid');
    });
    return () => {
      cancelled = true;
    };
  }, [destinationType, watchedAddress]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function close(next: boolean) {
    if (!next) {
      reset({ currency: 'NGN', destinationType: 'bank_account', destinationDetails: {} });
      setStage('form');
      setServerError(null);
      setWithdrawalRequestId(null);
      setApprovalId(null);
      setMethods([]);
      setTotpCode('');
      setKycBlocked(false);
      if (pollRef.current) clearInterval(pollRef.current);
    }
    onOpenChange(next);
  }

  function onContinue() {
    setStage('confirm');
  }

  async function onSubmit(data: WithdrawRequestInput) {
    setServerError(null);
    setKycBlocked(false);
    setIsSubmitting(true);

    const res = await fetch('/api/wallet/withdraw/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, destinationType }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not create withdrawal request. Please try again.');
      if (body?.code === 'KYC_REQUIRED' || body?.code === 'LIMIT_EXCEEDED') setKycBlocked(true);
      return;
    }

    const body = await res.json();
    setWithdrawalRequestId(body.withdrawalRequestId);
    setApprovalId(body.stepUp.approvalId);
    setMethods(body.stepUp.methods);
    setStage('step-up');

    if (body.stepUp.methods.includes('push') || body.stepUp.methods.includes('telegram')) {
      pollRef.current = setInterval(() => pollApprovalStatus(body.stepUp.approvalId, body.withdrawalRequestId), 2000);
    }
  }

  async function pollApprovalStatus(pendingApprovalId: string, pendingWithdrawalRequestId: string) {
    const res = await fetch(`/api/auth/step-up/status/${pendingApprovalId}`);
    if (!res.ok) return;
    const { status } = await res.json();
    if (status === 'approved') {
      if (pollRef.current) clearInterval(pollRef.current);
      await confirmWithdrawal(pendingApprovalId, pendingWithdrawalRequestId);
    } else if (status === 'denied' || status === 'expired') {
      if (pollRef.current) clearInterval(pollRef.current);
      setServerError(`Step-up approval was ${status}. Please try again.`);
      setStage('form');
    }
  }

  async function submitTotpCode() {
    if (!approvalId || !withdrawalRequestId) return;
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/auth/step-up/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_id: approvalId, method: 'totp', totp_code: totpCode }),
    });

    if (!res.ok) {
      setIsSubmitting(false);
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not verify code. Please try again.');
      return;
    }

    await confirmWithdrawal(approvalId, withdrawalRequestId);
  }

  async function confirmWithdrawal(pendingApprovalId: string, pendingWithdrawalRequestId: string) {
    const res = await fetch('/api/wallet/withdraw/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ withdrawalRequestId: pendingWithdrawalRequestId, stepUpApprovalId: pendingApprovalId }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not complete withdrawal. Please try again.');
      return;
    }

    setStage('done');
    onWithdrawn();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent mobileSheet>
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>Move funds out of your VaultPoint wallet.</DialogDescription>
        </DialogHeader>

        {serverError && (
          <div role="alert" className="mb-4 space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <p>{serverError}</p>
            {kycBlocked && onKycBlocked && (
              <Button type="button" variant="outline" size="sm" onClick={onKycBlocked}>
                Verify identity
              </Button>
            )}
          </div>
        )}

        {stage === 'form' && (
          <form onSubmit={handleSubmit(onContinue)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <select
                id="currency"
                {...register('currency')}
                className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary"
              >
                {wallets.map((w) => (
                  <option key={w.currency} value={w.currency}>
                    {w.currency} (available: {w.balance_cached})
                  </option>
                ))}
                {wallets.length === 0 && <option value="NGN">NGN</option>}
              </select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="amount">Amount</Label>
                {selectedWallet && (
                  <span className="text-xs text-text-tertiary">
                    Available: {formatMoneyJSON({ amount: String(selectedWallet.balance_cached), currency })}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Input id="amount" type="number" step="0.01" min="0" className="font-mono-num" {...register('amount')} />
                {selectedWallet && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setValue('amount', Number(selectedWallet.balance_cached), { shouldValidate: true })}
                  >
                    Max
                  </Button>
                )}
              </div>
              {errors.amount && <p className="text-xs text-warning">{errors.amount.message}</p>}
              {showReviewHold && (
                <p className="text-xs text-warning">
                  Withdrawals over {formatMoneyJSON({ amount: String(WITHDRAWAL_REVIEW_HOLD_THRESHOLD_NGN), currency: 'NGN' })} are
                  reviewed within 24h.
                </p>
              )}
            </div>

            {destinationType === 'bank_account' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="accountName">Account name</Label>
                  <Input id="accountName" {...register('destinationDetails.accountName')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="accountNumber">Account number</Label>
                  <Input id="accountNumber" {...register('destinationDetails.accountNumber')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bankCode">Bank code</Label>
                  <Input id="bankCode" {...register('destinationDetails.bankCode')} />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="address">Destination address (TRC-20)</Label>
                <Input id="address" {...register('destinationDetails.address')} />
                {addressValidity === 'invalid' && (
                  <p className="text-xs text-warning">This doesn&apos;t look like a valid TRC-20 (TRON) address.</p>
                )}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={destinationType === 'crypto_address' && addressValidity === 'invalid'}>
              Continue
            </Button>
          </form>
        )}

        {stage === 'confirm' && (
          <div className="space-y-4">
            <div className="space-y-1 rounded-lg border border-border bg-surface-elevated p-4 text-sm">
              <div className="flex justify-between text-text-secondary">
                <span>Amount</span>
                <span className="font-mono-num text-text-primary">
                  {formatMoneyJSON({ amount: String(watchedAmount), currency })}
                </span>
              </div>
              <div className="flex justify-between text-text-secondary">
                <span>Fee</span>
                <span className="text-text-primary">No fee</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1 text-text-secondary">
                <span>You&apos;ll receive</span>
                <span className="font-mono-num text-text-primary">
                  {formatMoneyJSON({ amount: String(watchedAmount), currency })}
                </span>
              </div>
            </div>
            {showReviewHold && (
              <p className="text-xs text-warning">
                Withdrawals over {formatMoneyJSON({ amount: String(WITHDRAWAL_REVIEW_HOLD_THRESHOLD_NGN), currency: 'NGN' })} are
                reviewed within 24h.
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStage('form')}>
                Back
              </Button>
              <Button className="flex-1" isLoading={isSubmitting} onClick={handleSubmit(onSubmit)}>
                Confirm withdrawal
              </Button>
            </div>
          </div>
        )}

        {stage === 'step-up' && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              For your security, confirm this withdrawal before it&apos;s processed.
            </p>

            {methods.length === 0 && (
              <p className="text-sm text-warning">
                No verification method is set up on your account yet — add a device, TOTP app, or Telegram link in
                Settings to enable withdrawals.
              </p>
            )}

            {methods.includes('totp') && (
              <div className="space-y-2">
                <Label htmlFor="totpCode">6-digit code</Label>
                <Input
                  id="totpCode"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
                <Button className="w-full" onClick={submitTotpCode} isLoading={isSubmitting} disabled={totpCode.length !== 6}>
                  Confirm withdrawal
                </Button>
              </div>
            )}

            {!methods.includes('totp') && (methods.includes('push') || methods.includes('telegram')) && (
              <p className="text-sm text-text-secondary">
                Waiting for approval on your {methods.includes('telegram') ? 'linked Telegram account' : 'registered device'}
                &hellip;
              </p>
            )}
          </div>
        )}

        {stage === 'done' && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-text-primary">Withdrawal submitted and is being processed.</p>
            <Button className="w-full" onClick={() => close(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
