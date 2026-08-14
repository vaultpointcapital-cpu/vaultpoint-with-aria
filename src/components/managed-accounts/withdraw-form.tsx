'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils/cn';
import type { ManagedTier } from '@/types/database';

type WithdrawalType = 'profit' | 'full_closure';

interface Breakdown {
  grossPnl: number;
  clientSharePct: number;
  clientShare: number;
  vaultpointShare: number;
}

interface PreviewResponse {
  withdrawalType: WithdrawalType;
  breakdown: Breakdown;
  principal?: number;
  netToClient?: number;
}

interface WithdrawFormProps {
  accountId: string;
  tier: ManagedTier;
  profitSplitPct: number;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const UNDERSTANDING_TEXT: Record<WithdrawalType, string> = {
  profit:
    'I am withdrawing only the profit accrued since my last distribution. My account stays open and continues trading at its current risk settings.',
  full_closure:
    'I am withdrawing my entire balance and closing this Managed Account. Aria will stop trading this sub-account immediately once this is confirmed, even if the account is currently in a drawdown — my principal is returned regardless.',
};

export function WithdrawForm({ accountId, tier, profitSplitPct }: WithdrawFormProps) {
  const router = useRouter();
  const [withdrawalType, setWithdrawalType] = useState<WithdrawalType>('profit');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);

  const [payoutMethod, setPayoutMethod] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setConfirmed(false);
    setIsLoadingPreview(true);

    fetch(`/api/managed-accounts/${accountId}/withdraw/preview?type=${withdrawalType}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setPreviewError(body?.error ?? 'Could not load a withdrawal preview.');
          return;
        }
        setPreview(body);
      })
      .finally(() => setIsLoadingPreview(false));
  }, [accountId, withdrawalType]);

  async function onSubmit() {
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/managed-accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ withdrawalType, payoutMethod, confirmUnderstanding: true }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not submit your withdrawal request.');
      return;
    }

    const { distribution } = await res.json();
    router.push(`/dashboard/managed-accounts/${accountId}/distributions/${distribution.id}`);
  }

  const netToClient = withdrawalType === 'profit' ? preview?.breakdown.clientShare : preview?.netToClient;

  return (
    <div className="mx-auto max-w-lg space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Request a withdrawal</h1>
        <p className="mt-1 text-sm text-text-tertiary capitalize">{tier} Managed Account — {profitSplitPct}% split</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setWithdrawalType('profit')}
          className={cn(
            'rounded-lg border p-3 text-left text-sm transition-colors',
            withdrawalType === 'profit' ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'
          )}
        >
          <p className="font-medium text-text-primary">Withdraw profit</p>
          <p className="mt-1 text-xs text-text-tertiary">Keep the account open and trading.</p>
        </button>
        <button
          type="button"
          onClick={() => setWithdrawalType('full_closure')}
          className={cn(
            'rounded-lg border p-3 text-left text-sm transition-colors',
            withdrawalType === 'full_closure' ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'
          )}
        >
          <p className="font-medium text-text-primary">Withdraw &amp; close</p>
          <p className="mt-1 text-xs text-text-tertiary">Return everything and end the account.</p>
        </button>
      </div>

      {isLoadingPreview && <p className="text-sm text-text-tertiary">Calculating your breakdown…</p>}

      {previewError && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {previewError}
        </div>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {withdrawalType === 'full_closure' && preview.principal !== undefined && (
              <div className="flex justify-between text-text-secondary">
                <span>Principal returned</span>
                <span>{formatCurrency(preview.principal)}</span>
              </div>
            )}
            <div className="flex justify-between text-text-secondary">
              <span>Gross P&amp;L</span>
              <span>{formatCurrency(preview.breakdown.grossPnl)}</span>
            </div>
            <div className="flex justify-between text-text-secondary">
              <span>Your share ({preview.breakdown.clientSharePct}%)</span>
              <span>{formatCurrency(preview.breakdown.clientShare)}</span>
            </div>
            <div className="flex justify-between text-text-secondary">
              <span>VaultPoint&apos;s share</span>
              <span>{formatCurrency(preview.breakdown.vaultpointShare)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold text-text-primary">
              <span>Net to you</span>
              <span>{netToClient !== undefined ? formatCurrency(netToClient) : '—'}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {preview && (
        <>
          <div className="space-y-2">
            <Label htmlFor="payoutMethod">Payout destination</Label>
            <Input
              id="payoutMethod"
              placeholder="e.g. Bank transfer to account ending 4821"
              value={payoutMethod}
              onChange={(e) => setPayoutMethod(e.target.value)}
            />
            <p className="text-xs text-text-tertiary">
              No live payout rail is connected yet — this request is reviewed and paid out manually.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-elevated p-3">
            <input
              id="confirmUnderstanding"
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <Label htmlFor="confirmUnderstanding" className="text-xs font-normal leading-relaxed text-text-secondary">
              {UNDERSTANDING_TEXT[withdrawalType]}
            </Label>
          </div>

          {serverError && (
            <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
              {serverError}
            </div>
          )}

          <Button
            className="w-full"
            disabled={!confirmed || payoutMethod.trim().length === 0}
            isLoading={isSubmitting}
            onClick={onSubmit}
          >
            {withdrawalType === 'full_closure' ? 'Withdraw everything & close account' : 'Request withdrawal'}
          </Button>
        </>
      )}
    </div>
  );
}
