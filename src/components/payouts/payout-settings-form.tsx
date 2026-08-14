'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { PayoutSettings, PropPayoutAgreement } from '@/types/database';

interface PayoutSettingsFormProps {
  settings: PayoutSettings;
  agreements: PropPayoutAgreement[];
}

export function PayoutSettingsForm({ settings, agreements }: PayoutSettingsFormProps) {
  const router = useRouter();
  const [walletAddress, setWalletAddress] = useState(settings.vaultpoint_crypto_wallet_address ?? '');
  const [network, setNetwork] = useState(settings.vaultpoint_crypto_network ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const response = await fetch('/api/admin/payout-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultpointCryptoWalletAddress: walletAddress || null,
        vaultpointCryptoNetwork: network || null,
      }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? 'Could not save payout settings.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Payout settings</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          Until VaultPoint&apos;s crypto wallet address is set below, new crypto_two_step payouts calculate a split
          with no VaultPoint destination — fixable here, never silently defaulted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>VaultPoint collection wallet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="VaultPoint's crypto wallet address"
            className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
          />
          <input
            type="text"
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            placeholder="Network (e.g. TRC20, ERC20)"
            className="w-full rounded-lg border border-border bg-background p-2 text-sm text-text-primary"
          />
          {error && <p className="text-sm text-warning">{error}</p>}
          <Button isLoading={saving} onClick={handleSave}>
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payout agreements ({agreements.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {agreements.length === 0 ? (
            <p className="text-sm text-text-tertiary">
              No prop-funded accounts have a payout agreement yet — create one via POST
              /api/admin/prop-payout-agreements (connection id + user id + split terms).
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              {agreements.map((agreement) => (
                <div key={agreement.id} className="rounded-lg border border-border p-3">
                  <p className="text-text-primary">
                    {agreement.funding_partner} — {agreement.profit_split_pct}% trader ({agreement.split_direction.replace(/_/g, ' ')})
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    Connection {agreement.broker_connection_id.slice(0, 8)} ·{' '}
                    {agreement.trader_payout_wallet_address ? 'crypto wallet on file' : 'no wallet on file yet'} ·{' '}
                    {agreement.active ? 'active' : 'inactive'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
