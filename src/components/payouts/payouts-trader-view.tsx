'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { PayoutLedgerEntry, PropPayoutAgreement, WithdrawalEvent } from '@/types/database';

interface PayoutsTraderViewProps {
  events: WithdrawalEvent[];
  ledgerEntries: PayoutLedgerEntry[];
  agreement: PropPayoutAgreement | null;
}

const STATUS_COPY: Record<PayoutLedgerEntry['status'], string> = {
  pending: 'Calculating collection — VaultPoint will charge the card on file for its share.',
  pending_trader_execution: 'Awaiting your two-step withdrawal — see instructions below.',
  collected: "VaultPoint's share has been received. This payout is finalized.",
  disputed: 'This payout is under dispute.',
  failed: 'Collection failed — VaultPoint will follow up.',
};

export function PayoutsTraderView({ events, ledgerEntries, agreement }: PayoutsTraderViewProps) {
  const router = useRouter();
  const [walletAddress, setWalletAddress] = useState(agreement?.trader_payout_wallet_address ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ledgerByEventId = new Map(ledgerEntries.map((l) => [l.withdrawal_event_id, l]));

  async function saveWallet() {
    if (!agreement) return;
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/prop-payout-agreements/${agreement.id}/wallet`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? 'Could not save your wallet address.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Payouts</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          Withdrawals themselves happen through Hantec, outside VaultPoint. What&apos;s shown here is VaultPoint&apos;s
          separate, subsequent calculation of the profit split on a withdrawal you already made — VaultPoint never
          moves your funds.
        </p>
      </div>

      {agreement && (
        <Card>
          <CardHeader>
            <CardTitle>Your payout wallet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-text-tertiary">
              Where VaultPoint should send your share when you execute the second leg of a two-step withdrawal.
            </p>
            <input
              type="text"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              placeholder="Your crypto wallet address"
              className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
            />
            {error && <p className="text-sm text-warning">{error}</p>}
            <Button size="sm" isLoading={saving} onClick={saveWallet}>
              Save
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Detected withdrawals</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-text-tertiary">No withdrawals detected yet.</p>
          ) : (
            <div className="space-y-3">
              {events.map((event) => {
                const entry = ledgerByEventId.get(event.id);
                return (
                  <div key={event.id} className="rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium text-text-primary">
                      Withdrawal of {event.detected_amount} — {new Date(event.detected_at).toLocaleDateString()}
                    </p>
                    {event.status === 'pending' && event.confidence === 'requires_manual_confirmation' && (
                      <p className="mt-1 text-xs text-text-tertiary">Under review before your split is calculated.</p>
                    )}
                    {entry && (
                      <>
                        <p className="mt-1 text-xs text-text-tertiary">
                          Your share: {entry.trader_amount} · VaultPoint&apos;s share: {entry.vaultpoint_amount}
                        </p>
                        <p className="mt-1 text-xs text-text-tertiary">{STATUS_COPY[entry.status]}</p>
                        {entry.status === 'pending_trader_execution' && (
                          <div className="mt-2 rounded-md bg-surface-elevated p-2 text-xs text-text-secondary">
                            <p>Send {entry.trader_amount} to your own wallet, and separately send {entry.vaultpoint_amount} to:</p>
                            <p className="mt-1 font-mono">{entry.vaultpoint_wallet_address ?? 'not yet configured — contact support'}</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
